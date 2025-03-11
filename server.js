import { db } from "./firebaseAdmin.js";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { google } from "googleapis";

// Load the custom .env file
dotenv.config({ path: './render.env' });

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Server is running!");
});

// Load Google service account credentials
let credentials;
try {
  credentials = {
    type: process.env.GOOGLE_TYPE,
    project_id: process.env.GOOGLE_PROJECT_ID,
    private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    auth_uri: process.env.GOOGLE_AUTH_URI,
    token_uri: process.env.GOOGLE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.GOOGLE_AUTH_PROVIDER_CERT_URL,
    client_x509_cert_url: process.env.GOOGLE_CLIENT_CERT_URL,
  };
} catch (error) {
  console.error("Failed to load service account credentials:", error);
  process.exit(1);
}

// Initialize Google Auth Client
const auth = new google.auth.JWT({
  email: credentials.client_email,
  key: credentials.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const SPREADSHEET_ID = "1I1ev3Cp3dz-vPHhWT9zzIdDJyvM74eVfiNxwdEbxKpM";
const SHEET_NAME = "Sheet1";

// Fetch entire master sheet data
async function fetchMasterSheetData() {
  const sheets = google.sheets({ version: "v4", auth });
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_NAME,
    });
    return response.data.values || [];
  } catch (error) {
    console.error("Error fetching master sheet:", error);
    return null;
  }
}

// Get Client P&L
async function getClientPL(client, groups, masterSheetData) {
  const clientGroups = groups.filter(group => client.groups_client_is_part_of.includes(group.groupID));

  const joiningDate = new Date(client.joining_date._seconds * 1000);
  joiningDate.setUTCHours(0, 0, 0, 0);

  let plPercentageTotal = 0;
  let plAbsTotal = 0;
  let totalCalls = 0;
  let failedGroups = [];

  for (const group of clientGroups) {
    const relevantRows = masterSheetData.filter(row => row[1] === group.groupName);

    if (relevantRows.length === 0) {
      failedGroups.push(group.groupName);
      continue;
    }

    for (const row of relevantRows) {
      let rawDate = row[2];
      let entryDate;

      if (typeof rawDate === "string") {
        let [day, month, year] = rawDate.split("/").map(Number);
        entryDate = new Date(year, month - 1, day);
      } else {
        entryDate = new Date(rawDate);
      }

      if (isNaN(entryDate.getTime()) || entryDate < joiningDate) continue;

      let plPercentage = parseFloat(row[13]) || 0;
      let plAbs = parseFloat(row[14]) || 0;

      plPercentageTotal += plPercentage;
      plAbsTotal += plAbs;
      totalCalls++;
    }
  }

  return { plPercentageTotal, plAbsTotal, totalCalls, failedGroups };
}

// Get Client Reports Count
async function getClientReportsCount(client, groups) {
  const clientGroups = groups.filter(group => client.groups_client_is_part_of.includes(group.groupID));
  const joiningDate = new Date(client.joining_date._seconds * 1000);
  let totalReports = 0;

  for (const group of clientGroups) {
    try {
      const reportsSnapshot = await db.collection("groups").doc(group.id).collection("reports").get();
      reportsSnapshot.forEach(doc => {
        const reportData = doc.data();
        if (reportData.timestamp && reportData.timestamp._seconds * 1000 >= joiningDate.getTime()) {
          totalReports++;
        }
      });
    } catch (error) {
      console.error(`Error fetching reports for group ${group.groupName}:`, error);
    }
  }

  return totalReports;
}

// API Endpoint
app.get("/api/data", async (req, res) => {
  try {
    const usersCollection = await db.collection("users").get();
    const users = usersCollection.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const groupsCollection = await db.collection("groups").get();
    const groups = groupsCollection.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const masterSheetData = await fetchMasterSheetData();
    if (!masterSheetData) {
      return res.status(500).json({ error: "Failed to fetch master sheet data" });
    }

    const processedUsers = await Promise.all(
      users.map(async (user) => {
        if (user.role !== "user" || !user.groups_client_is_part_of) return user;
        const { plPercentageTotal, plAbsTotal, totalCalls, failedGroups } = await getClientPL(user, groups, masterSheetData);
        const totalReports = await getClientReportsCount(user, groups);

        return {
          ...user,
          totalPLPercentage: plPercentageTotal,
          totalPLAbs: plAbsTotal,
          totalCalls,
          totalReports,
          failedGroups,
        };
      })
    );

    res.json({ users: processedUsers, groups });
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Failed to fetch data", details: error.message });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

