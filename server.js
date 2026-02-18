import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import AWS from "aws-sdk";
import sharp from "sharp";
import sqlite3 from "sqlite3";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const db = new sqlite3.Database("./attendance.db");
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS students (
    usn TEXT PRIMARY KEY,
    name TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usn TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});
const upload = multer({ storage: multer.memoryStorage() });
const rekognition = new AWS.Rekognition({ region: process.env.AWS_REGION });
const COLLECTION_ID = process.env.COLLECTION_ID || "KrishFaces";


console.log("Using Rekognition collection:", COLLECTION_ID);
/* =========================
   DATABASE HELPERS
========================= */
const getStudentByUSN = (usn) => {
  return new Promise((resolve) => {
    db.get("SELECT name FROM students WHERE usn = ?", [usn], (err, row) => resolve(row));
  });
};

/* =========================
   ENSURE COLLECTION
========================= */
async function ensureCollection() {
  try {
    await rekognition.describeCollection({ CollectionId: COLLECTION_ID }).promise();
  } catch {
    await rekognition.createCollection({ CollectionId: COLLECTION_ID }).promise();
  }
}
ensureCollection();
// Get Graph Data
app.get("/api/stats", (req, res) => {
  db.all(`SELECT date(timestamp) as day, count(*) as count 
          FROM attendance GROUP BY day ORDER BY day DESC LIMIT 7`, 
          (err, rows) => res.json(rows || []));
});

/* =========================
   GET ALL ExternalImageId
========================= */
app.get("/api/external-ids", async (req, res) => {
  try {
    let faces = [];
    let nextToken = null;

    do {
      const data = await rekognition.listFaces({
        CollectionId: COLLECTION_ID,
        NextToken: nextToken
      }).promise();

      faces = faces.concat(data.Faces || []);
      nextToken = data.NextToken;
    } while (nextToken);

    // unique ExternalImageId
    const uniqueIds = [
      ...new Set(faces.map(f => f.ExternalImageId).filter(Boolean))
    ];

    res.json(uniqueIds);

  } catch (err) {
    console.error("List faces error:", err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   ADD PERSON
========================= */
app.post("/api/detect", upload.single("photo"), async (req, res) => {
  try {
    console.log("1. Request received at /api/detect");
    if (!req.file) return res.status(400).json({ error: "No image" });

    // FIX: Define 'buffer' from the uploaded file
    const buffer = req.file.buffer; 
    
    const meta = await sharp(buffer).metadata();
    const detect = await rekognition.detectFaces({ Image: { Bytes: buffer } }).promise();
    
    console.log("2. Faces detected by AWS:", detect.FaceDetails.length);
    const results = [];

    for (const face of detect.FaceDetails) {
      const box = face.BoundingBox;

      // Calculate safe coordinates for Sharp
      const left = Math.max(0, Math.floor(box.Left * meta.width));
      const top = Math.max(0, Math.floor(box.Top * meta.height));
      const width = Math.min(meta.width - left, Math.floor(box.Width * meta.width));
      const height = Math.min(meta.height - top, Math.floor(box.Height * meta.height));

      // LINE 138 FIX: Use the 'buffer' variable defined above
      const crop = await sharp(buffer)
        .extract({ left, top, width, height })
        .toBuffer();

      const search = await rekognition.searchFacesByImage({
        CollectionId: COLLECTION_ID,
        Image: { Bytes: crop },
        MaxFaces: 1,
        FaceMatchThreshold: 75 // Slightly lowered for better matching
      }).promise();

      const match = search.FaceMatches && search.FaceMatches.length > 0 ? search.FaceMatches[0] : null;
      let studentInfo = null;

      if (match) {
        const usn = match.Face.ExternalImageId;
        const student = await getStudentByUSN(usn);
        db.run("INSERT INTO attendance (usn) VALUES (?)", [usn]);

        studentInfo = {
          name: student ? student.name : "Unknown",
          usn: usn,
          similarity: match.Similarity
        };
        console.log(`Match found: ${studentInfo.name}`);
      } else {
        console.log("No match found in collection.");
      }

      results.push({ boundingBox: box, match: studentInfo });
    }
    res.json({ results });

  } catch (err) {
    console.error("DETECTION ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});
/* =========================
   ADD PERSON ROUTE
========================= */
app.post("/api/add-person", upload.array("photos"), async (req, res) => {
  try {
    const { fullName, usn } = req.body;
    const files = req.files;

    if (!fullName || !usn || !files?.length) {
      return res.status(400).json({ error: "Missing name, USN, or photos" });
    }

    // Save to SQLite Database
    db.run("INSERT OR REPLACE INTO students (usn, name) VALUES (?, ?)", [usn.toUpperCase(), fullName]);

    // Send each photo to AWS Rekognition Collection
    for (const file of files) {
      await rekognition.indexFaces({
        CollectionId: COLLECTION_ID,
        ExternalImageId: usn.toUpperCase(), // Linking face to USN
        Image: { Bytes: file.buffer }
      }).promise();
    }
    
    console.log(`Successfully registered: ${fullName} (${usn})`);
    res.json({ message: `Student ${fullName} registered successfully.` });
  } catch (err) {
    console.error("Add Person Error:", err);
    res.status(500).json({ error: err.message });
  }
});
/* =========================
   START SERVER
========================= */
app.listen(5002, () => console.log("Server running on http://localhost:5002"));