// Telling the terminal what a foreman program is doing, the way coding agents
// do: OSC 7501, the Program Status Protocol that herdr-core stores and the
// Herdr clients (desktop, phone) show. One implementation, used by the
// launcher and by `foreman watch`.

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const ESC = String.fromCharCode(27);

// One status report. state is idle, working, done, blocked, error or clear;
// msg and title travel as base64; progress is 0 to 100.
export function statusSeq({ state, msg = '', title = '', progress = null }) {
  const fields = [
    `state=${state}`,
    ...(progress === null ? [] : [`progress=${Math.max(0, Math.min(100, Math.round(progress)))}`]),
    'app=foreman',
    ...(title ? [`title=${b64(title)}`] : []),
    ...(msg ? [`msg=${b64(msg)}`] : []),
  ];
  return `${ESC}]7501;${fields.join(':')}${ESC}${String.fromCharCode(92)}`;
}

// The terminal's title (OSC 2): what the phone shows next to the space name.
export const titleSeq = (text) => `${ESC}]2;${text.replace(/[\x00-\x1f\x7f]/g, ' ')}${String.fromCharCode(7)}`;
