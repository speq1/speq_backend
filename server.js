import { db } from "./firebaseAdmin.js";
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { google } from "googleapis";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Server is running!");
});

// Load Google service account credentials
let credentials;
try {
  credentials = JSON.parse(fs.readFileSync("service-account.json"));
} catch (error) {
  console.error("Failed to load service account credentials:", error);
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const SPREADSHEET_ID = "1I1ev3Cp3dz-vPHhWT9zzIdDJyvM74eVfiNxwdEbxKpM"; // Your Master Sheet ID
const SHEET_NAME = "Sheet1"; // Change if needed

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
    console.error(`Error fetching master sheet:`, error);
    return null;
  }
}

// Get Client P&L
async function getClientPL(client, groups, masterSheetData) {
  const clientGroups = groups.filter(group => client.groups_client_is_part_of.includes(group.groupID));

  console.log(`\nNow starting for user: ${client.name}`);
  console.log("groups_client_is_part_of", "(array)", client.groups_client_is_part_of);

  const joiningDate = new Date(client.joining_date._seconds * 1000);
  joiningDate.setUTCHours(0, 0, 0, 0);
  console.log(`\nJoining Date: ${joiningDate.toISOString()}`);

  let plPercentageTotal = 0;
  let plAbsTotal = 0;
  let totalCalls = 0;
  let failedGroups = [];

  for (const group of clientGroups) {
    console.log(`\nNow starting for groupID ${group.groupID}`);

    // Filter relevant rows from master sheet where Plan == groupName
    const relevantRows = masterSheetData.filter(row => row[1] === group.groupName); // Column B (Plan)

    if (relevantRows.length === 0) {
      failedGroups.push(group.groupName);
      console.log(`❌ No matching data found for group ${group.groupName}`);
      continue;
    }

    let groupPlPercentageTotal = 0;
    let groupPlAbsTotal = 0;
    let groupCalls = 0;

    for (const row of relevantRows) {
      let rawDate = row[2]; // Column C (Entry Date)
      let entryDate;

      if (typeof rawDate === "string") {
        let [day, month, year] = rawDate.split("/").map(Number);
        entryDate = new Date(year, month - 1, day);
      } else {
        entryDate = new Date(rawDate);
      }

      if (isNaN(entryDate.getTime())) continue;

      let plPercentage = parseFloat(row[13]) || 0; // Column N
      let plAbs = parseFloat(row[14]) || 0; // Column O

      if (entryDate >= joiningDate) {
        groupPlPercentageTotal += plPercentage;
        groupPlAbsTotal += plAbs;
        groupCalls++;
      }
    }

    console.log(`Sum of all P&L(%) = ${groupPlPercentageTotal}, Sum of all P&L(Abs) = ${groupPlAbsTotal}`);
    plPercentageTotal += groupPlPercentageTotal;
    plAbsTotal += groupPlAbsTotal;
    totalCalls += groupCalls;
  }

  console.log(`\nFinal P&L for ${client.name}: P&L(%) = ${plPercentageTotal}, P&L(Abs) = ${plAbsTotal}, Total Calls = ${totalCalls}`);
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
      let groupReportsCount = 0;

      reportsSnapshot.forEach(doc => {
        const reportData = doc.data();
        if (reportData.timestamp && reportData.timestamp._seconds * 1000 >= joiningDate.getTime()) {
          groupReportsCount++;
        }
      });

      totalReports += groupReportsCount;
      console.log(`User: ${client.name} | Group: ${group.groupName} | Reports Count: ${groupReportsCount}`);
    } catch (error) {
      console.error(`Error fetching reports for group ${group.groupName}:`, error);
    }
  }

  console.log(`Final Reports Count for ${client.name}: ${totalReports}`);
  return totalReports;
}

// API Endpoint
app.get("/api/data", async (req, res) => {
  try {
    console.log("Fetching users and groups...");

    const usersCollection = await db.collection("users").get();
    const users = usersCollection.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const groupsCollection = await db.collection("groups").get();
    const groups = groupsCollection.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    console.log("Fetching master sheet data...");
    const masterSheetData = await fetchMasterSheetData();
    if (!masterSheetData) {
      return res.status(500).json({ error: "Failed to fetch master sheet data" });
    }

    // Process users
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
          failedGroups 
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
