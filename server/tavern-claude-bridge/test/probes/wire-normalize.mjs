// Only request-local IDs and the calendar date vary independently of bridge code.
// Do not reserialize JSON: field order, all prompt bytes, and parameters stay checked.
export function normalizeWire(raw) {
  return raw.replace(/(\\"device_id\\":\\")[^"\\]+/g, '$1<device>')
    .replace(/(\\"session_id\\":\\")[^"\\]+/g, '$1<session>')
    .replace(/Today's date is \d{4}-\d{2}-\d{2}\./g, "Today's date is <date>.");
}
