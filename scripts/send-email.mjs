import { createTransport } from "nodemailer";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const { values } = parseArgs({
  options: {
    to: { type: "string" },
    subject: { type: "string" },
    body: { type: "string", default: "" },
    attach: { type: "string", multiple: true, default: [] },
  },
});

const { to, subject, body, attach } = values;

const server = process.env.SMTP_SERVER;
const port = Number(process.env.SMTP_PORT) || 465;
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASSWORD;

if (!server || !user || !pass) {
  console.error("Missing SMTP env vars: SMTP_SERVER, SMTP_USER, SMTP_PASSWORD");
  process.exit(1);
}
if (!to) {
  console.error("Missing --to");
  process.exit(1);
}
if (!subject) {
  console.error("Missing --subject");
  process.exit(1);
}

const transporter = createTransport({
  host: server,
  port,
  secure: port === 465,
  auth: { user, pass },
});

const attachments = attach.map((p) => ({
  filename: basename(p),
  path: p,
  cid: basename(p),
}));

let html = body;
for (const a of attachments) {
  html += `<p><img src="cid:${a.cid}" alt="${a.filename}" style="width:128px;height:128px;margin:8px;border-radius:12px" /></p>`;
}

const info = await transporter.sendMail({
  from: user,
  to,
  subject,
  html,
  attachments,
});

console.log("Email sent:", info.messageId);
process.exit(0);