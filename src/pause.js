// Keep a message on screen until a key is pressed (or a few seconds pass when
// there is no terminal to press it in).

export function waitForKey({ stdin, stdout, message = 'Press any key to close.', sleep, fallbackMs = 10000 }) {
  stdout.write(`\n  ${message} `);
  if (!stdin.isTTY || stdin.readableEnded) return sleep(fallbackMs);
  return new Promise((resolve) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', () => {
      stdin.setRawMode(false);
      stdin.pause();
      resolve();
    });
  });
}
