const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

// This line makes Express serve your website files from the public folder
app.use(express.static("public"));

const draftsPath = path.join(__dirname, "data", "drafts.json");

// Homepage website
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Draft invoices API
app.get("/drafts", (req, res) => {
  try {
    const data = fs.readFileSync(draftsPath);
    const drafts = JSON.parse(data);
    res.json(drafts);
  } catch (err) {
    res.status(500).send("Error reading drafts");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
