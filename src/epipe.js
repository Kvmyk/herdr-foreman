// `foreman agents | head` closes our output early: that is not an error.

export function quietPipes(streams, exit = (code) => process.exit(code)) {
  for (const stream of streams) {
    stream.on('error', (err) => {
      if (err.code === 'EPIPE') exit(0);
      else throw err;
    });
  }
}
