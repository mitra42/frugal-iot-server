/*
 * Sending mail, configured in config.d/email.yaml.
 *
 * Absent or incomplete configuration means this server does not send mail. That is a supported
 * state - most installations are a Pi in a shed - so mailConfigured() lets a caller say so plainly
 * instead of accepting a request and dropping it.
 */
import nodemailer from 'nodemailer';

let transport = null;
let mailFrom = null;

// emailConfig is config.email, i.e. config.d/email.yaml. Returns a line for the startup log.
function mailInit(emailConfig) {
  transport = null;
  mailFrom = null;
  if (!emailConfig || !emailConfig.host || !emailConfig.from) {
    return "Not sending mail (no host/from in config.d/email.yaml) - password reset is unavailable";
  }
  const port = emailConfig.port || 587;
  transport = nodemailer.createTransport({
    host: emailConfig.host,
    port,
    // 465 is TLS from the first byte; 587 and 25 start plain and STARTTLS. Wrong either way is a
    // connection that hangs rather than an error that says what is wrong, so derive it.
    secure: (emailConfig.secure !== undefined) ? emailConfig.secure : (port === 465),
    auth: emailConfig.user ? { user: emailConfig.user, pass: emailConfig.pass } : undefined,
  });
  mailFrom = emailConfig.from;
  return `Sending mail via ${emailConfig.host}:${port} as ${mailFrom}`;
}

function mailConfigured() { return !!transport; }

// cb(err) - nodemailer is promise-based, wrapped here because the rest of this codebase is callbacks
function sendMail({ to, subject, text, html }, cb) {
  if (!transport) { return cb(new Error("Mail is not configured on this server")); }
  transport.sendMail({ from: mailFrom, to, subject, text, html })
    .then(() => cb(null))
    .catch((err) => cb(err));
}

export { mailInit, mailConfigured, sendMail };
