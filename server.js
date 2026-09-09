const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = 3000;

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "data.json");
const PUBLIC_DIR = path.join(ROOT, "public");

function loadData() {
  try {
    return JSON.parse(
      fs.readFileSync(DATA_FILE, "utf8")
    );
  } catch (error) {
    console.error("Could not read data.json:", error);
    process.exit(1);
  }
}

let db = loadData();

function saveData() {
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(db, null, 2),
    "utf8"
  );
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

function sendHTML(res, file) {
  const filePath = path.join(PUBLIC_DIR, file);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8"
  });

  res.end(
    fs.readFileSync(filePath)
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(
          new Error("Invalid JSON")
        );
      }
    });

    req.on("error", reject);
  });
}

/* ============================
   SESSION SYSTEM
============================ */

const sessions = new Map();

function createSession(user) {
  const token =
    crypto.randomBytes(32).toString("hex");

  sessions.set(token, {
    userId: user.id,
    expires:
      Date.now() +
      12 * 60 * 60 * 1000
  });

  return token;
}

function getSession(req) {
  const auth =
    req.headers.authorization || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  const token =
    auth.substring(7);

  const session =
    sessions.get(token);

  if (!session) {
    return null;
  }

  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }

  const user =
    db.users.find(
      u => u.id === session.userId
    );

  if (!user || user.status !== "active") {
    return null;
  }

  return {
    token,
    user
  };
}

function requireAuth(req, res) {
  const session =
    getSession(req);

  if (!session) {
    sendJSON(res, 401, {
      error: "Please sign in."
    });

    return null;
  }

  return session;
}

/* ============================
   DATE / TIME
============================ */

function todayString() {
  const d = new Date();

  const year =
    d.getFullYear();

  const month =
    String(d.getMonth() + 1)
      .padStart(2, "0");

  const day =
    String(d.getDate())
      .padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function timeString(date = new Date()) {
  return date.toLocaleTimeString(
    "en-GB",
    {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }
  );
}

function isLate(clockIn) {
  const lateAfter =
    db.settings.lateAfter ||
    "08:00";

  const d =
    new Date(clockIn);

  const current =
    `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;

  return current > lateAfter;
}

/* ============================
   GPS DISTANCE
============================ */

function calculateDistance(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371000;

  const toRadians =
    degrees =>
      degrees *
      Math.PI /
      180;

  const dLat =
    toRadians(lat2 - lat1);

  const dLon =
    toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(
      toRadians(lat1)
    ) *
    Math.cos(
      toRadians(lat2)
    ) *
    Math.sin(dLon / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

/* ============================
   GPS DIRECTION
============================ */

function calculateDirection(
  schoolLat,
  schoolLon,
  teacherLat,
  teacherLon
) {
  const lat1 =
    schoolLat *
    Math.PI /
    180;

  const lat2 =
    teacherLat *
    Math.PI /
    180;

  const dLon =
    (teacherLon - schoolLon) *
    Math.PI /
    180;

  const y =
    Math.sin(dLon) *
    Math.cos(lat2);

  const x =
    Math.cos(lat1) *
      Math.sin(lat2) -
    Math.sin(lat1) *
      Math.cos(lat2) *
      Math.cos(dLon);

  let bearing =
    Math.atan2(y, x) *
    180 /
    Math.PI;

  bearing =
    (bearing + 360) %
    360;

  const directions = [
    "NORTH",
    "NORTH-EAST",
    "EAST",
    "SOUTH-EAST",
    "SOUTH",
    "SOUTH-WEST",
    "WEST",
    "NORTH-WEST"
  ];

  const index =
    Math.round(
      bearing / 45
    ) % 8;

  return directions[index];
}

/* ============================
   AUTOMATIC 11-HOUR CLOCK OUT
============================ */

function processAutomaticClockOuts() {
  let changed = false;

  const hours =
    Number(
      db.settings.autoClockOutHours ||
      11
    );

  const now =
    Date.now();

  db.attendance.forEach(record => {

    if (
      record.clockIn &&
      !record.clockOut
    ) {

      const clockIn =
        new Date(
          record.clockIn
        ).getTime();

      const automaticTime =
        clockIn +
        hours *
        60 *
        60 *
        1000;

      if (
        now >= automaticTime
      ) {

        record.clockOut =
          new Date(
            automaticTime
          ).toISOString();

        record.clockOutType =
          "AUTO_11_HOUR";

        changed = true;

        db.audit.push({
          id:
            Date.now() +
            Math.random(),
          action:
            "AUTOMATIC_CLOCK_OUT",
          adminName:
            "SYSTEM",
          details:
            `Automatic clock-out after ${hours} hours`,
          createdAt:
            new Date().toISOString()
        });
      }
    }
  });

  if (changed) {
    saveData();
  }
}

/* ============================
   AUDIT
============================ */

function audit(
  action,
  admin,
  details
) {
  db.audit.push({
    id:
      Date.now() +
      Math.random(),
    action,
    adminName:
      admin
        ? admin.fullName
        : "SYSTEM",
    details,
    createdAt:
      new Date().toISOString()
  });

  saveData();
}

/* ============================
   USER SAFE DATA
============================ */

function safeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    fullName: user.fullName,
    staffNo: user.staffNo,
    username: user.username,
    role: user.role,
    department:
      user.department || "",
    subjects:
      user.subjects || "",
    classTeacher:
      user.classTeacher || "NO",
    status:
      user.status,
    photo:
      user.photo || ""
  };
}

/* ============================
   START SERVER
============================ */

const server =
  http.createServer(
    async (req, res) => {

      try {

        processAutomaticClockOuts();

        const parsed =
          new URL(
            req.url,
            `http://localhost:${PORT}`
          );

        const pathname =
          parsed.pathname;

        /* ======================
           FRONTEND
        ====================== */

        if (
          req.method === "GET" &&
          pathname === "/"
        ) {
          sendHTML(
            res,
            "index.html"
          );
          return;
        }

        /* ======================
           LOGIN
        ====================== */

        if (
          req.method === "POST" &&
          pathname === "/api/login"
        ) {

          const body =
            await readBody(req);

          const username =
            String(
              body.username || ""
            ).trim();

          const password =
            String(
              body.password || ""
            );

          const user =
            db.users.find(
              u =>
                u.username ===
                  username &&
                u.status === "active"
            );

          if (
            !user ||
            user.password !== password
          ) {

            sendJSON(
              res,
              401,
              {
                error:
                  "Invalid username or password."
              }
            );

            return;
          }

          const token =
            createSession(user);

          sendJSON(
            res,
            200,
            {
              token,
              user:
                safeUser(user),
              locationSetupRequired:
                user.role === "admin" &&
                !db.settings.locationConfigured
            }
          );

          return;
        }

        /* ======================
           LOGOUT
        ====================== */

        if (
          req.method === "POST" &&
          pathname === "/api/logout"
        ) {

          const auth =
            req.headers.authorization ||
            "";

          if (
            auth.startsWith(
              "Bearer "
            )
          ) {

            sessions.delete(
              auth.substring(7)
            );
          }

          sendJSON(
            res,
            200,
            { ok: true }
          );

          return;
        }

        /* ======================
           CURRENT USER
        ====================== */

        if (
          req.method === "GET" &&
          pathname === "/api/me"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          sendJSON(
            res,
            200,
            {
              user:
                safeUser(
                  session.user
                )
            }
          );

          return;
        }

        /* ======================
           FIRST SCHOOL LOCATION
        ====================== */

        if (
          req.method === "POST" &&
          pathname ===
            "/api/settings/initial-location"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "admin"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Only an administrator can configure the school location."
              }
            );

            return;
          }

          if (
            db.settings.locationConfigured
          ) {

            sendJSON(
              res,
              409,
              {
                error:
                  "The school location has already been configured."
              }
            );

            return;
          }

          const body =
            await readBody(req);

          const latitude =
            Number(body.latitude);

          const longitude =
            Number(body.longitude);

          if (
            !Number.isFinite(
              latitude
            ) ||
            !Number.isFinite(
              longitude
            )
          ) {

            sendJSON(
              res,
              400,
              {
                error:
                  "Valid GPS coordinates are required."
              }
            );

            return;
          }

          db.settings.latitude =
            latitude;

          db.settings.longitude =
            longitude;

          db.settings.radius =
            500;

          db.settings.locationConfigured =
            true;

          db.settings.locationConfiguredBy =
            session.user.fullName;

          db.settings.locationConfiguredAt =
            new Date().toISOString();

          saveData();

          audit(
            "INITIAL_SCHOOL_LOCATION_SET",
            session.user,
            `School location configured at latitude ${latitude}, longitude ${longitude}, radius 500 metres.`
          );

          sendJSON(
            res,
            200,
            {
              ok: true,
              settings:
                db.settings
            }
          );

          return;
        }

        /* ======================
           SETTINGS
        ====================== */

        if (
          req.method === "GET" &&
          pathname ===
            "/api/settings"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          sendJSON(
            res,
            200,
            {
              settings:
                db.settings
            }
          );

          return;
        }

        /* ======================
           UPDATE SETTINGS
        ====================== */

        if (
          req.method === "PUT" &&
          pathname ===
            "/api/settings"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "admin"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Only administrators can change settings."
              }
            );

            return;
          }

          const body =
            await readBody(req);

          if (
            Number.isFinite(
              Number(body.radius)
            )
          ) {
            db.settings.radius =
              Number(body.radius);
          }

          if (
            body.lateAfter
          ) {
            db.settings.lateAfter =
              body.lateAfter;
          }

          if (
            body.expectedOut
          ) {
            db.settings.expectedOut =
              body.expectedOut;
          }

          if (
            body.latitude !==
              undefined &&
            body.longitude !==
              undefined
          ) {

            const lat =
              Number(body.latitude);

            const lon =
              Number(body.longitude);

            if (
              Number.isFinite(lat) &&
              Number.isFinite(lon)
            ) {

              db.settings.latitude =
                lat;

              db.settings.longitude =
                lon;

              db.settings.locationConfigured =
                true;

              db.settings.locationConfiguredBy =
                session.user.fullName;

              db.settings.locationConfiguredAt =
                new Date().toISOString();
            }
          }

          saveData();

          audit(
            "SETTINGS_UPDATED",
            session.user,
            "Attendance system settings updated."
          );

          sendJSON(
            res,
            200,
            {
              ok: true,
              settings:
                db.settings
            }
          );

          return;
        }

        /* ======================
           TEACHER REGISTRATION
        ====================== */

        if (
          req.method === "POST" &&
          pathname ===
            "/api/register"
        ) {

          const body =
            await readBody(req);

          const fullName =
            String(
              body.fullName || ""
            ).trim();

          const staffNo =
            String(
              body.staffNo || ""
            ).trim();

          const username =
            String(
              body.username || ""
            ).trim();

          const password =
            String(
              body.password || ""
            );

          const confirmPassword =
            String(
              body.confirmPassword ||
                ""
            );

          if (
            !fullName ||
            !staffNo ||
            !username ||
            !password
          ) {

            sendJSON(
              res,
              400,
              {
                error:
                  "Please complete all required fields."
              }
            );

            return;
          }

          if (
            password !==
            confirmPassword
          ) {

            sendJSON(
              res,
              400,
              {
                error:
                  "Passwords do not match."
              }
            );

            return;
          }

          const usernameExists =
            db.users.some(
              u =>
                u.username
                  .toLowerCase() ===
                username.toLowerCase()
            ) ||
            db.applications.some(
              a =>
                a.username
                  .toLowerCase() ===
                username.toLowerCase() &&
                a.status === "PENDING"
            );

          const staffExists =
            db.users.some(
              u =>
                u.staffNo
                  .toLowerCase() ===
                staffNo.toLowerCase()
            ) ||
            db.applications.some(
              a =>
                a.staffNo
                  .toLowerCase() ===
                staffNo.toLowerCase() &&
                a.status === "PENDING"
            );

          if (
            usernameExists
          ) {

            sendJSON(
              res,
              409,
              {
                error:
                  "Username already exists."
              }
            );

            return;
          }

          if (
            staffExists
          ) {

            sendJSON(
              res,
              409,
              {
                error:
                  "Staff number already exists."
              }
            );

            return;
          }

          const application = {
            id:
              db.nextApplicationId++,
            fullName,
            staffNo,
            username,
            password,
            department:
              body.department || "",
            subjects:
              body.subjects || "",
            classTeacher:
              body.classTeacher ||
              "NO",
            submittedAt:
              new Date().toISOString(),
            status: "PENDING",
            decisionReason: ""
          };

          db.applications.push(
            application
          );

          saveData();

          sendJSON(
            res,
            201,
            {
              ok: true,
              message:
                "Registration submitted successfully. Please wait for Admin approval."
            }
          );

          return;
        }

        /* ======================
           DASHBOARD
        ====================== */

        if (
          req.method === "GET" &&
          pathname ===
            "/api/dashboard"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          processAutomaticClockOuts();

          const today =
            todayString();

          const teachers =
            db.users.filter(
              u =>
                u.role ===
                  "teacher" &&
                u.status ===
                  "active"
            );

          const todayAttendance =
            db.attendance.filter(
              a =>
                a.date === today
            );

          const present =
            todayAttendance.length;

          const late =
            todayAttendance.filter(
              a => a.late
            ).length;

          const outside =
            todayAttendance.filter(
              a =>
                a.areaStatus ===
                "OUTSIDE"
            ).length;

          const stillClocked =
            todayAttendance.filter(
              a =>
                !a.clockOut
            ).length;

          const clockedOut =
            todayAttendance.filter(
              a =>
                !!a.clockOut
            ).length;

          const automatic =
            todayAttendance.filter(
              a =>
                a.clockOutType ===
                "AUTO_11_HOUR"
            ).length;

          let attendance =
            db.attendance
              .slice()
              .sort(
                (a, b) =>
                  new Date(
                    b.clockIn
                  ) -
                  new Date(
                    a.clockIn
                  )
              );

          if (
            session.user.role ===
            "teacher"
          ) {

            attendance =
              attendance.filter(
                a =>
                  a.userId ===
                  session.user.id
              );
          }

          const teacherAttendance =
            db.attendance.filter(
              a =>
                a.userId ===
                session.user.id &&
                a.date === today
            )[0] || null;

          sendJSON(
            res,
            200,
            {
              stats: {
                totalStaff:
                  teachers.length,
                present,
                absent:
                  Math.max(
                    0,
                    teachers.length -
                      present
                  ),
                late,
                outside,
                clockedOut,
                stillClocked,
                automatic,
                percentage:
                  teachers.length
                    ? Math.round(
                        present /
                          teachers.length *
                          100
                      )
                    : 0
              },

              settings:
                db.settings,

              todayAttendance,

              attendance,

              myAttendance:
                teacherAttendance,

              applications:
                session.user.role ===
                "admin"
                  ? db.applications
                      .slice()
                      .sort(
                        (a, b) =>
                          new Date(
                            b.submittedAt
                          ) -
                          new Date(
                            a.submittedAt
                          )
                      )
                  : [],

              teachers:
                session.user.role ===
                "admin"
                  ? teachers.map(
                      safeUser
                    )
                  : [],

              audit:
                session.user.role ===
                "admin"
                  ? db.audit
                      .slice()
                      .reverse()
                  : []
            }
          );

          return;
        }

        /* ======================
           CLOCK IN
        ====================== */

        if (
          req.method === "POST" &&
          pathname ===
            "/api/attendance/clock-in"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "teacher"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Only teachers can clock in."
              }
            );

            return;
          }

          if (
            !db.settings.locationConfigured
          ) {

            sendJSON(
              res,
              400,
              {
                error:
                  "The school location has not been configured by an Admin yet."
              }
            );

            return;
          }

          const today =
            todayString();

          const existing =
            db.attendance.find(
              a =>
                a.userId ===
                  session.user.id &&
                a.date === today
            );

          if (existing) {

            sendJSON(
              res,
              409,
              {
                error:
                  "You have already clocked in today."
              }
            );

            return;
          }

          const body =
            await readBody(req);

          const latitude =
            Number(
              body.latitude
            );

          const longitude =
            Number(
              body.longitude
            );

          const accuracy =
            Number(
              body.accuracy || 0
            );

          if (
            !Number.isFinite(
              latitude
            ) ||
            !Number.isFinite(
              longitude
            )
          ) {

            sendJSON(
              res,
              400,
              {
                error:
                  "Valid GPS location is required."
              }
            );

            return;
          }

          const distance =
            calculateDistance(
              db.settings.latitude,
              db.settings.longitude,
              latitude,
              longitude
            );

          const areaStatus =
            distance <=
            db.settings.radius
              ? "WITHIN"
              : "OUTSIDE";

          const direction =
            calculateDirection(
              db.settings.latitude,
              db.settings.longitude,
              latitude,
              longitude
            );

          const clockIn =
            new Date();

          const record = {
            id:
              db.nextAttendanceId++,
            userId:
              session.user.id,
            teacherName:
              session.user.fullName,
            staffNo:
              session.user.staffNo,
            date:
              today,
            clockIn:
              clockIn.toISOString(),
            clockOut:
              null,
            clockOutType:
              null,

            teacherLatitude:
              latitude,

            teacherLongitude:
              longitude,

            accuracy,

            schoolLatitude:
              db.settings.latitude,

            schoolLongitude:
              db.settings.longitude,

            distance:
              Math.round(
                distance
              ),

            direction,

            areaStatus,

            late:
              isLate(clockIn),

            corrected:
              false,

            correction:
              null
          };

          db.attendance.push(
            record
          );

          saveData();

          sendJSON(
            res,
            201,
            {
              ok: true,

              message:
                "Clock-in recorded successfully.",

              teacherStatus:
                areaStatus,

              clockIn:
                record.clockIn
            }
          );

          return;
        }

        /* ======================
           CLOCK OUT
        ====================== */

        if (
          req.method === "POST" &&
          pathname ===
            "/api/attendance/clock-out"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "teacher"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Only teachers can clock out."
              }
            );

            return;
          }

          processAutomaticClockOuts();

          const today =
            todayString();

          const record =
            db.attendance.find(
              a =>
                a.userId ===
                  session.user.id &&
                a.date === today
            );

          if (!record) {

            sendJSON(
              res,
              404,
              {
                error:
                  "You have not clocked in today."
              }
            );

            return;
          }

          if (
            record.clockOut
          ) {

            sendJSON(
              res,
              409,
              {
                error:
                  `You were already clocked out (${record.clockOutType}).`
              }
            );

            return;
          }

          record.clockOut =
            new Date().toISOString();

          record.clockOutType =
            "MANUAL";

          saveData();

          sendJSON(
            res,
            200,
            {
              ok: true,
              message:
                "Manual clock-out recorded."
            }
          );

          return;
        }

        /* ======================
           APPROVE APPLICATION
        ====================== */

        const approveMatch =
          pathname.match(
            /^\/api\/applications\/(\d+)\/approve$/
          );

        if (
          req.method === "POST" &&
          approveMatch
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "admin"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Admin only."
              }
            );

            return;
          }

          const id =
            Number(
              approveMatch[1]
            );

          const application =
            db.applications.find(
              a => a.id === id
            );

          if (!application) {

            sendJSON(
              res,
              404,
              {
                error:
                  "Application not found."
              }
            );

            return;
          }

          if (
            application.status !==
            "PENDING"
          ) {

            sendJSON(
              res,
              400,
              {
                error:
                  "This application has already been processed."
              }
            );

            return;
          }

          const usernameExists =
            db.users.some(
              u =>
                u.username
                  .toLowerCase() ===
                application.username
                  .toLowerCase()
            );

          const staffExists =
            db.users.some(
              u =>
                u.staffNo
                  .toLowerCase() ===
                application.staffNo
                  .toLowerCase()
            );

          if (
            usernameExists ||
            staffExists
          ) {

            sendJSON(
              res,
              409,
              {
                error:
                  "Username or staff number already belongs to another user."
              }
            );

            return;
          }

          const newUser = {
            id:
              db.nextUserId++,
            fullName:
              application.fullName,
            staffNo:
              application.staffNo,
            username:
              application.username,
            password:
              application.password,
            role:
              "teacher",
            department:
              application.department,
            subjects:
              application.subjects,
            classTeacher:
              application.classTeacher,
            status:
              "active",
            photo:
              ""
          };

          db.users.push(
            newUser
          );

          application.status =
            "APPROVED";

          application.decisionReason =
            "Approved by Admin";

          application.decidedAt =
            new Date().toISOString();

          application.decidedBy =
            session.user.fullName;

          saveData();

          audit(
            "TEACHER_APPLICATION_APPROVED",
            session.user,
            `Approved ${application.fullName} (${application.staffNo}).`
          );

          sendJSON(
            res,
            200,
            {
              ok: true,
              user:
                safeUser(newUser)
            }
          );

          return;
        }

        /* ======================
           REJECT APPLICATION
        ====================== */

        const rejectMatch =
          pathname.match(
            /^\/api\/applications\/(\d+)\/reject$/
          );

        if (
          req.method === "POST" &&
          rejectMatch
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "admin"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Admin only."
              }
            );

            return;
          }

          const id =
            Number(
              rejectMatch[1]
            );

          const application =
            db.applications.find(
              a => a.id === id
            );

          if (!application) {

            sendJSON(
              res,
              404,
              {
                error:
                  "Application not found."
              }
            );

            return;
          }

          const body =
            await readBody(req);

          application.status =
            "REJECTED";

          application.decisionReason =
            body.reason ||
            "Rejected by Admin";

          application.decidedAt =
            new Date().toISOString();

          application.decidedBy =
            session.user.fullName;

          saveData();

          audit(
            "TEACHER_APPLICATION_REJECTED",
            session.user,
            `Rejected ${application.fullName} (${application.staffNo}). Reason: ${application.decisionReason}`
          );

          sendJSON(
            res,
            200,
            {
              ok: true
            }
          );

          return;
        }

        /* ======================
           ADMIN ADD USER
        ====================== */

        if (
          req.method === "POST" &&
          pathname ===
            "/api/users"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "admin"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Admin only."
              }
            );

            return;
          }

          const body =
            await readBody(req);

          const fullName =
            String(
              body.fullName || ""
            ).trim();

          const staffNo =
            String(
              body.staffNo || ""
            ).trim();

          const username =
            String(
              body.username || ""
            ).trim();

          const password =
            String(
              body.password || ""
            );

          const role =
            body.role ===
            "admin"
              ? "admin"
              : "teacher";

          if (
            !fullName ||
            !staffNo ||
            !username ||
            !password
          ) {

            sendJSON(
              res,
              400,
              {
                error:
                  "Complete all required fields."
              }
            );

            return;
          }

          if (
            db.users.some(
              u =>
                u.username
                  .toLowerCase() ===
                username.toLowerCase()
            )
          ) {

            sendJSON(
              res,
              409,
              {
                error:
                  "Username already exists."
              }
            );

            return;
          }

          if (
            db.users.some(
              u =>
                u.staffNo
                  .toLowerCase() ===
                staffNo.toLowerCase()
            )
          ) {

            sendJSON(
              res,
              409,
              {
                error:
                  "Staff number already exists."
              }
            );

            return;
          }

          const user = {
            id:
              db.nextUserId++,
            fullName,
            staffNo,
            username,
            password,
            role,
            department:
              body.department ||
              "",
            subjects:
              body.subjects ||
              "",
            classTeacher:
              body.classTeacher ||
              "NO",
            status:
              "active",
            photo:
              ""
          };

          db.users.push(
            user
          );

          saveData();

          audit(
            "USER_CREATED",
            session.user,
            `Created ${role}: ${fullName} (${staffNo}).`
          );

          sendJSON(
            res,
            201,
            {
              ok: true,
              user:
                safeUser(user)
            }
          );

          return;
        }

        /* ======================
           ADMIN DISABLE USER
        ====================== */

        const disableMatch =
          pathname.match(
            /^\/api\/users\/(\d+)\/disable$/
          );

        if (
          req.method === "POST" &&
          disableMatch
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "admin"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Admin only."
              }
            );

            return;
          }

          const id =
            Number(
              disableMatch[1]
            );

          if (
            id ===
            session.user.id
          ) {

            sendJSON(
              res,
              400,
              {
                error:
                  "You cannot disable your own account."
              }
            );

            return;
          }

          const user =
            db.users.find(
              u => u.id === id
            );

          if (!user) {

            sendJSON(
              res,
              404,
              {
                error:
                  "User not found."
              }
            );

            return;
          }

          user.status =
            "inactive";

          saveData();

          audit(
            "USER_DISABLED",
            session.user,
            `Disabled ${user.fullName} (${user.staffNo}).`
          );

          sendJSON(
            res,
            200,
            {
              ok: true
            }
          );

          return;
        }

        /* ======================
           CORRECT ATTENDANCE
        ====================== */

        const correctionMatch =
          pathname.match(
            /^\/api\/attendance\/(\d+)\/correct$/
          );

        if (
          req.method === "POST" &&
          correctionMatch
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role !==
            "admin"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Admin only."
              }
            );

            return;
          }

          const id =
            Number(
              correctionMatch[1]
            );

          const record =
            db.attendance.find(
              a => a.id === id
            );

          if (!record) {

            sendJSON(
              res,
              404,
              {
                error:
                  "Attendance record not found."
              }
            );

            return;
          }

          const body =
            await readBody(req);

          const reason =
            String(
              body.reason || ""
            ).trim();

          if (!reason) {

            sendJSON(
              res,
              400,
              {
                error:
                  "A correction reason is required."
              }
            );

            return;
          }

          const original = {
            clockIn:
              record.clockIn,
            clockOut:
              record.clockOut,
            clockOutType:
              record.clockOutType,
            areaStatus:
              record.areaStatus,
            distance:
              record.distance
          };

          if (
            body.clockIn
          ) {
            record.clockIn =
              body.clockIn;
          }

          if (
            body.clockOut
          ) {
            record.clockOut =
              body.clockOut;
          }

          if (
            body.clockOutType
          ) {
            record.clockOutType =
              body.clockOutType;
          }

          record.corrected =
            true;

          record.correction = {
            original,
            correctedAt:
              new Date().toISOString(),
            correctedBy:
              session.user.fullName,
            reason
          };

          saveData();

          audit(
            "ATTENDANCE_CORRECTED",
            session.user,
            `Attendance #${id} corrected. Reason: ${reason}`
          );

          sendJSON(
            res,
            200,
            {
              ok: true,
              record
            }
          );

          return;
        }

        /* ======================
           REPORT DATA
        ====================== */

        if (
          req.method === "GET" &&
          pathname ===
            "/api/reports"
        ) {

          const session =
            requireAuth(
              req,
              res
            );

          if (!session) return;

          if (
            session.user.role ===
            "teacher"
          ) {

            sendJSON(
              res,
              403,
              {
                error:
                  "Reports are available to Admin and Principal."
              }
            );

            return;
          }

          const from =
            parsed.searchParams.get(
              "from"
            );

          const to =
            parsed.searchParams.get(
              "to"
            );

          let records =
            db.attendance.slice();

          if (from) {
            records =
              records.filter(
                a =>
                  a.date >= from
              );
          }

          if (to) {
            records =
              records.filter(
                a =>
                  a.date <= to
              );
          }

          records =
            records.sort(
              (a, b) =>
                new Date(
                  b.clockIn
                ) -
                new Date(
                  a.clockIn
                )
            );

          sendJSON(
            res,
            200,
            {
              records,
              settings:
                db.settings
            }
          );

          return;
        }

        /* ======================
           NOT FOUND
        ====================== */

        sendJSON(
          res,
          404,
          {
            error:
              "API route not found."
          }
        );

      } catch (error) {

        console.error(
          "SERVER ERROR:",
          error
        );

        sendJSON(
          res,
          500,
          {
            error:
              error.message ||
              "Server error."
          }
        );
      }
    }
  );

server.listen(
  PORT,
  () => {

    console.log("");
    console.log(
      "============================================"
    );
    console.log(
      " SAG ATTENDANCE SYSTEM"
    );
    console.log(
      "============================================"
    );
    console.log(
      ` Running at: http://localhost:${PORT}`
    );
    console.log("");
    console.log(
      "Demo Teacher: teacher / teacher123"
    );
    console.log(
      "Demo Admin:   admin / admin123"
    );
    console.log(
      "Demo Principal: principal / principal123"
    );
    console.log("");
  }
);
