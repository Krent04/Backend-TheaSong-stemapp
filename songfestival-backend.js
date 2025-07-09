const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

// ====== WACHTWOORDEN INSTELLEN =======
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "4sZ_apCc";
const SUBADMIN_WACHTWOORDEN = {
  "Antwerpen": "subadminAntwerpen",
  "Arnhem": "subadminArnhem",
  "ATKA": "subadminATKA",
  "Brussel": "subadminBrussel",
  "Den Bosch": "subadminDenBosch",
  "Filmacademie": "subadminFilmacademie",
  "Gent": "subadminGent",
  "Leuven": "subadminLeuven",
  "Maastricht": "subadminMaastricht",
  "Rotterdam": "subadminRotterdam",
  "Tilburg": "subadminTilburg",
  "Utrecht": "subadminUtrecht"
};

const SCHOLEN = [
  "Antwerpen", "Arnhem", "ATKA", "Brussel", "Den Bosch", "Filmacademie",
  "Gent", "Leuven", "Maastricht", "Rotterdam", "Tilburg", "Utrecht"
];
const SONGFESTIVAL_PUNTEN = [12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0];

// Mapping: schoolnaam => array van domeinen
const SCHOOL_DOMEINEN = {
  "Antwerpen": ["ap.be", "uantwerpen.be"],
  "Arnhem": ["student.artez.nl", "artez.nl", "gmail.com"],
  "ATKA": ["ahk.nl", "icloud.com"],
  "Brussel": ["ehb.be", "vub.be", "odisee.be"],
  "Den Bosch": ["avans.nl"],
  "Filmacademie": ["ahk.nl", "planet.nl"],
  "Gent": ["hogent.be"],
  "Leuven": ["kuleuven.be"],
  "Maastricht": ["zuyd.nl", "maastrichtuniversity.nl"],
  "Rotterdam": ["hr.nl", "codarts.nl"],
  "Tilburg": ["fontys.nl", "uvt.nl"],
  "Utrecht": ["hu.nl", "student.uu.nl"]
};
const TOEGESTAAN_DOMEINEN = Object.values(SCHOOL_DOMEINEN).flat();

function schoolVanEmail(email) {
  if (typeof email !== "string" || !email.includes("@")) return { naam: null };
  const emailDomein = email.split("@")[1].toLowerCase();
  for (const [school, domeinen] of Object.entries(SCHOOL_DOMEINEN)) {
    if (domeinen.some(dom => emailDomein.endsWith(dom))) {
      return { naam: school };
    }
  }
  return { naam: null };
}

// === Helper om schoolnamen niet-hoofdlettergevoelig te maken ===
function normalizeSchoolnaam(s) {
  if (typeof s !== "string") return s;
  const found = SCHOLEN.find(k => k.toLowerCase() === s.toLowerCase());
  return found || s;
}

const app = express();
const PORT = process.env.PORT || 4000;

// ======= CORS SETTINGS =========
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://theaterscholensongfestival-stemmen.netlify.app'
  ],
  credentials: true,
}));
app.use(bodyParser.json());

// ====== FILE UPLOADS voor foto's =====
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const naam = file.fieldname + '-' + Date.now() + ext;
    cb(null, naam);
  }
});
const upload = multer({ storage });

// ====== IN-MEMORY (of als JSON) OPSLAG ======
let aanvragen = []; // { id, school, naam, email, fotoUrl, status, stemcode, heeftGestemd, goedgekeurdDoor, afgekeurdDoor }
let stemmenVanSchool = {};
let gebruikteEmails = {};
let stemcodes = {}; // code -> aanvraagId

// ===== STEMLIJNEN OPEN/CLOSE =====
let lijnenOpen = true;

app.post("/lijnen", (req, res) => {
  const { open } = req.body;
  if (typeof open !== "boolean") return res.json({ message: "Geef 'open' true of false door." });
  lijnenOpen = open;
  res.json({ message: `De lijnen zijn nu ${open ? "geopend" : "gesloten"}.`, open: lijnenOpen });
});
app.post("/reset-stemmen", (req, res) => {
  stemmenVanSchool = {};
  gebruikteEmails = {};
  aanvragen = [];
  stemcodes = {};
  res.json({ message: "Alle stemmen, gebruikte e-mails en aanvragen zijn gewist." });
});
app.get("/lijnen-status", (req, res) => res.json({ open: lijnenOpen }));

// ====== STEMCODE VERIFICATIE ======
app.post("/verify-stemcode", (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ message: "Geen stemcode opgegeven." });
  // Zoek de aanvraag die bij deze stemcode hoort
  const aanvraag = aanvragen.find(
    a => a.stemcode && a.stemcode.toUpperCase() === code.trim().toUpperCase()
  );
  if (!aanvraag)
    return res.json({ message: "Ongeldige of niet bestaande stemcode." });
  if (aanvraag.status !== "goedgekeurd")
    return res.json({ message: "Deze code is niet (meer) geldig." });
  return res.json({ verified: true, school: aanvraag.school });
});

// ====== STEMMEN (met stemcode) ======
app.post("/vote", (req, res) => {
  if (!lijnenOpen)
    return res.json({ message: "De lijnen zijn gesloten. Stemmen is niet mogelijk." });

  const { puntenVerdeling, code } = req.body;

  if (code) {
    const aanvraag = aanvragen.find(
      a => a.stemcode && a.stemcode.toUpperCase() === code.trim().toUpperCase()
    );
    if (!aanvraag)
      return res.json({ message: "Ongeldige stemcode." });
    if (aanvraag.status !== "goedgekeurd")
      return res.json({ message: "Deze code is niet (meer) geldig." });
    if (aanvraag.heeftGestemd)
      return res.json({ message: "Met deze stemcode is al gestemd." });

    let stemmendeSchool = aanvraag.school;
    stemmendeSchool = normalizeSchoolnaam(stemmendeSchool);
    if (!SCHOLEN.includes(stemmendeSchool)) {
      return res.json({ message: "Onbekende school bij deze code." });
    }
    if (!puntenVerdeling)
      return res.json({ message: "puntenVerdeling is verplicht." });
    if (Object.keys(puntenVerdeling).includes(stemmendeSchool)) {
      return res.json({ message: "Je mag niet op je eigen school stemmen!" });
    }
    const puntenArray = Object.values(puntenVerdeling).map(Number);
    if (
      puntenArray.length !== SONGFESTIVAL_PUNTEN.length ||
      !puntenArray.includes(0) ||
      !SONGFESTIVAL_PUNTEN.every(p => puntenArray.filter(x => x === p).length === 1)
    ) {
      return res.json({
        message: `Punten moeten exact ${[...SONGFESTIVAL_PUNTEN].join(", ")} zijn, elk 1x gebruikt.`,
      });
    }
    const expectedScholen = SCHOLEN.filter(s => s !== stemmendeSchool);
    if (
      Object.keys(puntenVerdeling).length !== expectedScholen.length ||
      !Object.keys(puntenVerdeling).every(s => expectedScholen.includes(s))
    ) {
      return res.json({ message: "Er is iets mis met de lijst van scholen waar je op stemt." });
    }

    // --- Slechts 1 stem per school! ---
    stemmenVanSchool[stemmendeSchool] = [puntenVerdeling];
    aanvraag.heeftGestemd = true; // Markeer code als gebruikt

    // Logging
    console.log("Stem ontvangen van:", stemmendeSchool);
    console.log("Inhoud stemmenVanSchool:", JSON.stringify(stemmenVanSchool, null, 2));

    return res.json({ message: "Stem succesvol geregistreerd!" });
  }

  // Oude e-mail flow (mag je weghalen)
  const { email } = req.body;
  if (!email || !puntenVerdeling)
    return res.json({ message: "Email en puntenVerdeling zijn verplicht." });

  const emailKey = email.toLowerCase();
  if (gebruikteEmails[emailKey])
    return res.json({ message: "Met dit e-mailadres is al gestemd." });

  let schoolObj = schoolVanEmail(email);
  let stemmendeSchool = normalizeSchoolnaam(schoolObj.naam);
  if (!SCHOLEN.includes(stemmendeSchool))
    return res.json({ message: "School niet herkend op basis van e-mailadres." });

  if (Object.keys(puntenVerdeling).includes(stemmendeSchool)) {
    return res.json({ message: "Je mag niet op je eigen school stemmen!" });
  }
  const puntenArray = Object.values(puntenVerdeling).map(Number);
  if (
    puntenArray.length !== SONGFESTIVAL_PUNTEN.length ||
    !puntenArray.includes(0) ||
    !SONGFESTIVAL_PUNTEN.every(p => puntenArray.filter(x => x === p).length === 1)
  ) {
    return res.json({ message: `Punten moeten exact ${[...SONGFESTIVAL_PUNTEN].join(", ")} zijn, elk 1x gebruikt.` });
  }
  const expectedScholen = SCHOLEN.filter(s => s !== stemmendeSchool);
  if (
    Object.keys(puntenVerdeling).length !== expectedScholen.length ||
    !Object.keys(puntenVerdeling).every(s => expectedScholen.includes(s))
  ) {
    return res.json({ message: "Er is iets mis met de lijst van scholen waar je op stemt." });
  }

  stemmenVanSchool[stemmendeSchool] = [puntenVerdeling];
  gebruikteEmails[emailKey] = true;

  return res.json({ message: "Stem succesvol geregistreerd!" });
});

function berekenJuryUitslagGemiddelde(stemmenVanSchool, scholen, puntenLijst) {
  const juryUitslag = {};
  for (const school of scholen) {
    const stemmen = stemmenVanSchool[school] || [];
    if (stemmen.length === 0) continue;
    const andereScholen = scholen.filter(s => s !== school);
    const scores = {};
    for (const ontvanger of andereScholen) {
      const punten = stemmen.map(verdeling => Number(verdeling[ontvanger]) || 0);
      scores[ontvanger] = punten.length ? punten.reduce((a, b) => a + b, 0) / punten.length : 0;
    }
    const sorted = andereScholen.slice().sort((a, b) => scores[b] - scores[a]);
    const juryPunten = {};
    sorted.forEach((s, i) => {
      juryPunten[s] = puntenLijst[i] ?? 0;
    });
    juryUitslag[school] = juryPunten;
  }
  return juryUitslag;
}

// ===== WACHTWOORDCHECK MIDDLEWARE =====
function checkAdminPassword(req, res, next) {
  const pw =
    req.query.password ||
    req.headers["x-admin-password"] ||
    (req.body && req.body.password);
  if (pw !== ADMIN_PASSWORD) {
    return res
      .status(401)
      .send(`<div style="margin:50px auto;max-width:350px;background:#fffbe6;padding:32px 12px;border-radius:12px;box-shadow:0 2px 18px #0001;text-align:center">
          <h2 style="color:#d00">Niet geautoriseerd</h2>
          <p style="color:#333">Vul het juiste admin-wachtwoord in om deze pagina te bekijken.</p>
        </div>`);
  }
  next();
}
// ===== SUBADMIN CHECK =====
function checkSubadminPassword(req, res, next) {
  let school = req.query.school ? req.query.school : req.body.school;
  school = normalizeSchoolnaam(school);
  const pw =
    req.headers["x-subadmin-password"] ||
    (req.body && req.body.password) ||
    req.query.password;
  if (!school || pw !== SUBADMIN_WACHTWOORDEN[school]) {
    return res.status(401).json({ message: "Niet geautoriseerd voor subadmin van deze school." });
  }
  if (req.query.school) req.query.school = school;
  if (req.body && req.body.school) req.body.school = school;
  next();
}

// ========== NIEUWE ENDPOINTS VOOR AANVRAGEN ==========

// --- 1. Aanvraag indienen door gebruiker (met foto upload) ---
app.post("/aanvraag", upload.single("foto"), (req, res) => {
  let { school, naam, email } = req.body;
  school = normalizeSchoolnaam(school);
  if (!school || !naam || !email || !req.file) {
    return res.json({ message: "Vul alle velden in en upload een foto.", success: false });
  }
  if (!SCHOLEN.includes(school)) {
    return res.json({ message: "Ongeldige school.", success: false });
  }
  // Uniek ID genereren
  const id = "aanvraag_" + Date.now() + "_" + Math.floor(Math.random() * 1000000);
  const fotoUrl = `/uploads/${req.file.filename}`;
  aanvragen.push({
    id, school, naam, email, fotoUrl, status: "nieuw",
    goedgekeurdDoor: [], afgekeurdDoor: []
  });
  res.json({ message: "Aanvraag ontvangen! De subadmin van je school beoordeelt je aanvraag.", success: true });
});

// --- 2. Server static uploads voor foto's ---
app.use("/uploads", express.static(uploadDir));

// --- 3. Subadmin: aanvragen ophalen per school ---
app.get("/subadmin-aanvragen", checkSubadminPassword, (req, res) => {
  let school = normalizeSchoolnaam(req.query.school);
  if (!school || !SCHOLEN.includes(school)) return res.json([]);
  const lijst = aanvragen.filter(a => a.school === school);
  res.json(lijst);
});

// --- 4. Subadmin: aanvraag goedkeuren/afkeuren ---
function generateStemcode() {
  // Simpele code, mag beter/random in productie
  let code;
  do {
    code = (Math.random().toString(36).slice(2,10) + Math.floor(Math.random()*10000)).toUpperCase();
  } while (stemcodes[code]);
  return code;
}
app.post("/subadmin-aanvraag-actie", checkSubadminPassword, (req, res) => {
  let { id, actie, school } = req.body;
  school = normalizeSchoolnaam(school);
  const aanvraag = aanvragen.find(a => a.id === id && a.school === school);
  if (!aanvraag) return res.json({ message: "Aanvraag niet gevonden." });

  // Bepaal wie subadmin is (voor demo: schoolnaam, evt. uitbreiden met user info)
  const subadmin = school;

  if (actie === "goedkeuren") {
    aanvraag.status = "goedgekeurd";
    aanvraag.goedgekeurdDoor = aanvraag.goedgekeurdDoor || [];
    if (!aanvraag.goedgekeurdDoor.includes(subadmin)) {
      aanvraag.goedgekeurdDoor.push(subadmin);
    }
    // Genereer unieke stemcode en mail die, indien nog niet gedaan
    if (!aanvraag.stemcode) {
      const code = generateStemcode();
      aanvraag.stemcode = code;
      stemcodes[code] = aanvraag.id;
      transporter.sendMail({
        from: '"Songfestival" <theaterscholensongfestival@gmail.com>',
        to: aanvraag.email,
        subject: "Je stemcode voor het Songfestival",
        text: `Gefeliciteerd! Je aanvraag is goedgekeurd. Je unieke stemcode is: ${code}\nGebruik deze code om je stem uit te brengen.`,
        html: `<p>Gefeliciteerd! Je aanvraag is goedgekeurd.<br>Jouw unieke stemcode is: <b>${code}</b></p>
        <p>Gebruik deze code om je stem uit te brengen.</p>`
      }).catch(() => {});
    }
    res.json({ message: `Aanvraag goedgekeurd door ${subadmin}.` });
  } else if (actie === "afkeuren") {
    aanvraag.status = "afgekeurd";
    aanvraag.afgekeurdDoor = aanvraag.afgekeurdDoor || [];
    if (!aanvraag.afgekeurdDoor.includes(subadmin)) {
      aanvraag.afgekeurdDoor.push(subadmin);
    }
    res.json({ message: `Aanvraag afgekeurd door ${subadmin}.` });
  } else {
    res.json({ message: "Onbekende actie." });
  }
});

// --- 5. Hoofdadmin: overzicht aanvragen per school ---
app.get("/hoofdadmin-aanvragen", checkAdminPassword, (req, res) => {
  const overzicht = {};
  for (const school of SCHOLEN) {
    // geef ALLE relevante info terug
    overzicht[school] = aanvragen.filter(a => a.school === school);
  }
  res.json(overzicht);
});

// ========== EINDE AANVRAAG ENDPOINTS ==========

// ===== RESULTAAT-PAGINA MET WACHTWOORD ======
app.get("/results", checkAdminPassword, (req, res) => {
  console.log("stemmenVanSchool bij /results:", JSON.stringify(stemmenVanSchool, null, 2));
  const juryGemiddelde = berekenJuryUitslagGemiddelde(stemmenVanSchool, SCHOLEN, SONGFESTIVAL_PUNTEN);

  // Einduitslag berekenen
  const totaal = {};
  for (const jurySchool in juryGemiddelde) {
    for (const [ontvanger, punten] of Object.entries(juryGemiddelde[jurySchool])) {
      totaal[ontvanger] = (totaal[ontvanger] || 0) + punten;
    }
  }

  const uitslag = Object.entries(totaal)
    .map(([school, punten]) => ({ school, punten }))
    .sort((a, b) => b.punten - a.punten);

  // HTML opbouw: voor elke school, toon welke punten ze aan wie gaven
  const juryHtml = SCHOLEN.map((school) => {
    const puntenVerdeling = juryGemiddelde[school];
    if (!puntenVerdeling) {
      return `<section class="jury-school"><h3>${school}</h3><p>Geen stemmen uitgebracht.</p></section>`;
    }
    const puntenLijst = Object.entries(puntenVerdeling)
      .sort((a, b) => b[1] - a[1])
      .map(([ontvanger, punten]) =>
        `<li><span>${punten} punten</span> aan <b>${ontvanger}</b></li>`
      ).join("");
    return `
      <section class="jury-school">
        <h3>${school} gaf:</h3>
        <ul>${puntenLijst}</ul>
      </section>
    `;
  }).join("");

  const eindUitslagHtml = uitslag.map(
    ({ school, punten }, idx) =>
      `<li${idx === 0 ? ' class="winnaar"' : ''}><span>${idx + 1}. ${school}</span><span class="punten">${punten}</span></li>`
  ).join("");

  const stijl = `
    <style>
      :root {
        --accent: #ffb700;
        --light-bg: #f7f7fa;
        --card-bg: #fff;
        --jury-bg: #f2f3fc;
        --jury-title: #363171;
        --main: #23214b;
        --punten-bg: #e4e2ff;
        --punten-clr: #363171;
      }
      body {
        background: var(--light-bg);
        color: var(--main);
        font-family: 'Segoe UI', Arial, sans-serif;
        margin: 0;
        font-size: 18px;
      }
      .container {
        max-width: 700px;
        margin: 40px auto;
        background: var(--card-bg);
        border-radius: 18px;
        box-shadow: 0 6px 32px #0001;
        padding: 2.5em 1.5em 2em 1.5em;
      }
      h1 {
        margin-top: 0;
        font-weight: 900;
        font-size: 2.2em;
        letter-spacing: 1px;
        color: var(--jury-title);
        text-align: center;
      }
      h2 {
        margin-top: 2.2em;
        font-size: 1.4em;
        letter-spacing: 1px;
        color: var(--accent);
        text-align: center;
      }
      .jury-lijst {
        margin: 2em 0 2.5em 0;
      }
      .jury-school {
        background: var(--jury-bg);
        border-radius: 13px;
        margin-bottom: 20px;
        padding: 18px 18px 8px 18px;
        box-shadow: 0 2px 8px #0001;
      }
      .jury-school h3 {
        margin: 0 0 0.5em 0;
        color: var(--jury-title);
        font-size: 1.05em;
        letter-spacing: 0.2px;
      }
      .jury-school ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .jury-school li {
        display: flex;
        justify-content: flex-start;
        align-items: center;
        margin-bottom: 7px;
        font-size: 1em;
        gap: 8px;
      }
      .jury-school li span {
        min-width: 85px;
        font-weight: 600;
      }
      .punten {
        background: var(--punten-bg);
        color: var(--punten-clr);
        border-radius: 8px;
        padding: 2px 12px;
        font-weight: 600;
        margin-left: 1.2em;
        min-width: 2.2em;
        text-align: center;
        display: inline-block;
      }
      .einduitslag {
        background: linear-gradient(90deg,#fffbe6 0,#ffe5b3 100%);
        color: var(--main);
        border-radius: 13px;
        padding: 14px 16px 10px 16px;
        box-shadow: 0 2px 8px #0001;
        margin-top: 2em;
      }
      .einduitslag h2 {
        color: var(--accent);
        font-size: 1.3em;
        margin-bottom: 0.7em;
        text-align: center;
      }
      .einduitslag ul {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .einduitslag li {
        display: flex;
        justify-content: space-between;
        font-weight: 600;
        font-size: 1.08em;
        margin-bottom: 7px;
        align-items: center;
      }
      .einduitslag .winnaar {
        color: var(--accent);
        font-size: 1.25em;
        font-weight: 900;
        background: #fff6d0;
        border-radius: 6px;
        padding: 4px 0;
      }
      @media (max-width: 600px) {
        .container { padding: 1.3em 0.3em; }
        h1 { font-size: 1.18em; }
        h2 { font-size: 1em; }
        .jury-school { padding: 10px 6px 6px 8px; }
        .einduitslag { padding: 8px 4px; }
      }
    </style>
  `;

  res.send(`
    <!DOCTYPE html>
    <html lang="nl">
    <head>
      <meta charset="utf-8">
      <title>Songfestival Juryresultaten</title>
      ${stijl}
    </head>
    <body>
      <div class="container">
        <h1>Punten toegekend door elke school</h1>
        <div class="jury-lijst">
          ${juryHtml || "<p style='text-align:center'>Er zijn nog geen stemmen!</p>"}
        </div>
        <div class="einduitslag">
          <h2>Einduitslag</h2>
          <ul>
            ${eindUitslagHtml || "<li>Er zijn nog geen stemmen!</li>"}
          </ul>
        </div>
      </div>
    </body>
    </html>
  `);
});

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", port: 587, secure: false,
  auth: { user: "theaterscholensongfestival@gmail.com", pass: "vfjvdlyonrgmkxxe" }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend draait op http://0.0.0.0:${PORT}`);
});