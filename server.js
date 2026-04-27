/**
 * Invoice Agent - Main Server
 * 
 * A lightweight Node.js backend for creating, editing, and sending invoices.
 * Features:
 * - Draft invoice creation (weekly/monthly scheduling)
 * - Manual approval before sending
 * - PDF generation with pdfkit
 * - Email sending with nodemailer
 * - Payment reminders for unpaid invoices
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { generateInvoicePDF } from './invoiceGenerator.js';
import { sendInvoiceEmail, sendReminderEmail } from './emailService.js';
import { startScheduler } from './scheduler.js';

// Get directory name for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
app.use(express.json());

// File paths for JSON storage
const DATA_DIR = path.join(__dirname, 'data');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const INVOICES_FILE = path.join(DATA_DIR, 'invoices.json');

// ============================================
// Helper Functions for JSON File Operations
// ============================================

/**
 * Read data from a JSON file
 * @param {string} filePath - Path to the JSON file
 * @returns {Array} - Parsed JSON data or empty array
 */
function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error.message);
    return [];
  }
}

/**
 * Write data to a JSON file
 * @param {string} filePath - Path to the JSON file
 * @param {Array|Object} data - Data to write
 */
function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error.message);
  }
}

/**
 * Ensure data directory exists
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ============================================
// Customer Endpoints
// ============================================

/**
 * GET /customers
 * Get all customers
 */
app.get('/customers', (req, res) => {
  const customers = readJsonFile(CUSTOMERS_FILE);
  res.json(customers);
});

/**
 * POST /customers
 * Add a new customer
 */
app.post('/customers', (req, res) => {
  const customers = readJsonFile(CUSTOMERS_FILE);
  
  const newCustomer = {
    id: uuidv4(),
    name: req.body.name,
    email: req.body.email,
    address: req.body.address || '',
    phone: req.body.phone || '',
    // Recurring invoice settings
    recurringType: req.body.recurringType || null, // 'weekly' or 'monthly' or null
    recurringItems: req.body.recurringItems || [], // Default items for recurring invoices
    createdAt: new Date().toISOString()
  };
  
  customers.push(newCustomer);
  writeJsonFile(CUSTOMERS_FILE, customers);
  
  res.status(201).json({
    message: 'Customer created successfully',
    customer: newCustomer
  });
});

/**
 * PUT /customers/:id
 * Update a customer
 */
app.put('/customers/:id', (req, res) => {
  const customers = readJsonFile(CUSTOMERS_FILE);
  const index = customers.findIndex(c => c.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  
  // Update customer fields
  customers[index] = {
    ...customers[index],
    ...req.body,
    id: customers[index].id, // Keep original ID
    updatedAt: new Date().toISOString()
  };
  
  writeJsonFile(CUSTOMERS_FILE, customers);
  res.json({
    message: 'Customer updated successfully',
    customer: customers[index]
  });
});

// ============================================
// Draft Invoice Endpoints
// ============================================

/**
 * GET /drafts
 * Get all draft invoices
 */
app.get('/drafts', (req, res) => {
  const drafts = readJsonFile(DRAFTS_FILE);
  res.json(drafts);
});

/**
 * GET /drafts/:id
 * Get a specific draft invoice
 */
app.get('/drafts/:id', (req, res) => {
  const drafts = readJsonFile(DRAFTS_FILE);
  const draft = drafts.find(d => d.id === req.params.id);
  
  if (!draft) {
    return res.status(404).json({ error: 'Draft not found' });
  }
  
  res.json(draft);
});

/**
 * POST /drafts
 * Create a new draft invoice manually
 */
app.post('/drafts', (req, res) => {
  const drafts = readJsonFile(DRAFTS_FILE);
  const customers = readJsonFile(CUSTOMERS_FILE);
  
  // Find the customer
  const customer = customers.find(c => c.id === req.body.customerId);
  if (!customer) {
    return res.status(404).json({ error: 'Customer not found' });
  }
  
  // Calculate totals
  const items = req.body.items || [];
  const total = items.reduce((sum, item) => {
    return sum + (item.quantity * item.price);
  }, 0);
  
  const newDraft = {
    id: uuidv4(),
    invoiceNumber: `INV-${Date.now()}`,
    customerId: customer.id,
    customerName: customer.name,
    customerEmail: customer.email,
    customerAddress: customer.address,
    items: items,
    total: total,
    balance: total, // Balance starts equal to total
    status: 'draft', // draft, sent, paid
    dueDate: req.body.dueDate || null,
    notes: req.body.notes || '',
    createdAt: new Date().toISOString(),
    sentAt: null,
    paidAt: null
  };
  
  drafts.push(newDraft);
  writeJsonFile(DRAFTS_FILE, drafts);
  
  res.status(201).json({
    message: 'Draft invoice created successfully',
    draft: newDraft
  });
});

/**
 * PUT /drafts/:id
 * Edit a draft invoice before sending
 */
app.put('/drafts/:id', (req, res) => {
  const drafts = readJsonFile(DRAFTS_FILE);
  const index = drafts.findIndex(d => d.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Draft not found' });
  }
  
  // Only allow editing if still a draft
  if (drafts[index].status !== 'draft') {
    return res.status(400).json({ error: 'Cannot edit a sent invoice. Only drafts can be edited.' });
  }
  
  // Update allowed fields
  const allowedFields = ['items', 'dueDate', 'notes', 'customerAddress'];
  allowedFields.forEach(field => {
    if (req.body[field] !== undefined) {
      drafts[index][field] = req.body[field];
    }
  });
  
  // Recalculate total if items changed
  if (req.body.items) {
    drafts[index].total = req.body.items.reduce((sum, item) => {
      return sum + (item.quantity * item.price);
    }, 0);
    drafts[index].balance = drafts[index].total; // Reset balance when items change
  }
  
  drafts[index].updatedAt = new Date().toISOString();
  writeJsonFile(DRAFTS_FILE, drafts);
  
  res.json({
    message: 'Draft updated successfully',
    draft: drafts[index]
  });
});

/**
 * DELETE /drafts/:id
 * Delete a draft invoice
 */
app.delete('/drafts/:id', (req, res) => {
  const drafts = readJsonFile(DRAFTS_FILE);
  const index = drafts.findIndex(d => d.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Draft not found' });
  }
  
  if (drafts[index].status !== 'draft') {
    return res.status(400).json({ error: 'Cannot delete a sent invoice' });
  }
  
  drafts.splice(index, 1);
  writeJsonFile(DRAFTS_FILE, drafts);
  
  res.json({ message: 'Draft deleted successfully' });
});

/**
 * POST /drafts/:id/send
 * Approve and send the draft invoice via email with PDF attachment
 */
app.post('/drafts/:id/send', async (req, res) => {
  const drafts = readJsonFile(DRAFTS_FILE);
  const invoices = readJsonFile(INVOICES_FILE);
  const index = drafts.findIndex(d => d.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Draft not found' });
  }
  
  const draft = drafts[index];
  
  if (draft.status !== 'draft') {
    return res.status(400).json({ error: 'This invoice has already been sent' });
  }
  
  try {
    // Generate PDF
    const pdfPath = await generateInvoicePDF(draft);
    
    // Send email with PDF attachment
    await sendInvoiceEmail(draft, pdfPath);
    
    // Update draft status
    draft.status = 'sent';
    draft.sentAt = new Date().toISOString();
    
    // Move to invoices
    invoices.push(draft);
    writeJsonFile(INVOICES_FILE, invoices);
    
    // Remove from drafts
    drafts.splice(index, 1);
    writeJsonFile(DRAFTS_FILE, drafts);
    
    // Clean up PDF file
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    
    res.json({
      message: 'Invoice sent successfully!',
      invoice: draft
    });
  } catch (error) {
    console.error('Error sending invoice:', error);
    res.status(500).json({ error: 'Failed to send invoice: ' + error.message });
  }
});

// ============================================
// Invoice Endpoints (Sent Invoices)
// ============================================

/**
 * GET /invoices
 * Get all sent invoices
 */
app.get('/invoices', (req, res) => {
  const invoices = readJsonFile(INVOICES_FILE);
  res.json(invoices);
});

/**
 * GET /invoices/:id
 * Get a specific invoice
 */
app.get('/invoices/:id', (req, res) => {
  const invoices = readJsonFile(INVOICES_FILE);
  const invoice = invoices.find(i => i.id === req.params.id);
  
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  
  res.json(invoice);
});

/**
 * POST /invoices/:id/mark-paid
 * Mark an invoice as paid and set balance to 0
 */
app.post('/invoices/:id/mark-paid', (req, res) => {
  const invoices = readJsonFile(INVOICES_FILE);
  const index = invoices.findIndex(i => i.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  
  // Mark as paid
  invoices[index].status = 'paid';
  invoices[index].balance = 0;
  invoices[index].paidAt = new Date().toISOString();
  invoices[index].paymentMethod = req.body.paymentMethod || 'Not specified';
  invoices[index].paymentReference = req.body.paymentReference || '';
  
  writeJsonFile(INVOICES_FILE, invoices);
  
  res.json({
    message: 'Invoice marked as paid',
    invoice: invoices[index]
  });
});

// ============================================
// Reminder Endpoints
// ============================================

/**
 * GET /reminders
 * Get list of unpaid invoices that need a reminder
 * Invoices are marked for reminder if:
 * - Status is 'sent' (not paid)
 * - It's been more than 3 days since sending
 */
app.get('/reminders', (req, res) => {
  const invoices = readJsonFile(INVOICES_FILE);
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  
  const needsReminder = invoices.filter(invoice => {
    // Only sent (unpaid) invoices
    if (invoice.status !== 'sent') return false;
    
    // Check if sent more than 3 days ago
    const sentDate = new Date(invoice.sentAt);
    return sentDate < threeDaysAgo;
  });
  
  // Add days overdue info
  const reminders = needsReminder.map(invoice => ({
    ...invoice,
    daysOverdue: Math.floor((new Date() - new Date(invoice.sentAt)) / (1000 * 60 * 60 * 24)),
    needsReminder: true
  }));
  
  res.json(reminders);
});

/**
 * POST /invoices/:id/send-reminder
 * Send a payment reminder email for an unpaid invoice
 */
app.post('/invoices/:id/send-reminder', async (req, res) => {
  const invoices = readJsonFile(INVOICES_FILE);
  const index = invoices.findIndex(i => i.id === req.params.id);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  
  const invoice = invoices[index];
  
  if (invoice.status === 'paid') {
    return res.status(400).json({ error: 'This invoice is already paid' });
  }
  
  try {
    // Generate PDF for reminder
    const pdfPath = await generateInvoicePDF(invoice);
    
    // Send reminder email
    await sendReminderEmail(invoice, pdfPath);
    
    // Update reminder count
    invoice.reminderCount = (invoice.reminderCount || 0) + 1;
    invoice.lastReminderAt = new Date().toISOString();
    
    writeJsonFile(INVOICES_FILE, invoices);
    
    // Clean up PDF
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    
    res.json({
      message: 'Reminder sent successfully',
      invoice: invoice
    });
  } catch (error) {
    console.error('Error sending reminder:', error);
    res.status(500).json({ error: 'Failed to send reminder: ' + error.message });
  }
});

// ============================================
// Utility Endpoints
// ============================================

/**
 * GET /
 * API welcome message and available endpoints
 */
app.get('/', (req, res) => {
  res.json({
    message: '🧾 Invoice Agent API',
    version: '1.0.0',
    endpoints: {
      customers: {
        'GET /customers': 'List all customers',
        'POST /customers': 'Add a new customer',
        'PUT /customers/:id': 'Update a customer'
      },
      drafts: {
        'GET /drafts': 'List all draft invoices',
        'GET /drafts/:id': 'Get a specific draft',
        'POST /drafts': 'Create a new draft invoice',
        'PUT /drafts/:id': 'Edit a draft invoice',
        'DELETE /drafts/:id': 'Delete a draft invoice',
        'POST /drafts/:id/send': 'Approve and send invoice via email'
      },
      invoices: {
        'GET /invoices': 'List all sent invoices',
        'GET /invoices/:id': 'Get a specific invoice',
        'POST /invoices/:id/mark-paid': 'Mark invoice as paid'
      },
      reminders: {
        'GET /reminders': 'List invoices needing payment reminder',
        'POST /invoices/:id/send-reminder': 'Send payment reminder email'
      }
    }
  });
});

/**
 * POST /load-sample-data
 * Load sample data for testing
 */
app.post('/load-sample-data', (req, res) => {
  try {
    const sampleDataPath = path.join(__dirname, 'sample-data.json');
    
    if (!fs.existsSync(sampleDataPath)) {
      return res.status(404).json({ error: 'Sample data file not found' });
    }
    
    const sampleData = JSON.parse(fs.readFileSync(sampleDataPath, 'utf-8'));
    
    // Write sample data to respective files
    if (sampleData.customers) {
      writeJsonFile(CUSTOMERS_FILE, sampleData.customers);
    }
    if (sampleData.drafts) {
      writeJsonFile(DRAFTS_FILE, sampleData.drafts);
    }
    if (sampleData.invoices) {
      writeJsonFile(INVOICES_FILE, sampleData.invoices);
    }
    
    res.json({
      message: 'Sample data loaded successfully',
      loaded: {
        customers: sampleData.customers?.length || 0,
        drafts: sampleData.drafts?.length || 0,
        invoices: sampleData.invoices?.length || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load sample data: ' + error.message });
  }
});

// ============================================
// Server Startup
// ============================================

const PORT = process.env.PORT || 3000;

// Ensure data directory exists
ensureDataDir();

// Initialize empty JSON files if they don't exist
[CUSTOMERS_FILE, DRAFTS_FILE, INVOICES_FILE].forEach(file => {
  if (!fs.existsSync(file)) {
    writeJsonFile(file, []);
  }
});

// Start the scheduler for recurring invoices
startScheduler();

// Start the server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    🧾 Invoice Agent                       ║
║                                                           ║
║  Server running on http://localhost:${PORT}                  ║
║                                                           ║
║  Endpoints:                                               ║
║  • GET  /customers     - List customers                   ║
║  • GET  /drafts        - List draft invoices              ║
║  • PUT  /drafts/:id    - Edit a draft                     ║
║  • POST /drafts/:id/send - Send invoice via email         ║
║  • POST /invoices/:id/mark-paid - Mark as paid            ║
║  • GET  /reminders     - List unpaid invoices             ║
║                                                           ║
║  📅 Scheduler: Running daily at midnight                  ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

export default app;
