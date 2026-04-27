const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Load drafts safely
const draftsPath = path.join(__dirname, "data", "drafts.json");

app.get("/", (req, res) => {
  res.send("AI Invoice Agent is running 🚀");
});

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
