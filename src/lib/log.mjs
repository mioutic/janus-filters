// One JSON object per line on stderr: {"stage","event","level",...fields}.
// PIPELINE section 3. Never log a rule's full text at info; never log anything
// read from the environment.

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(stage, { quiet = false } = {}) {
  const threshold = quiet ? ORDER.warn : ORDER.debug;
  const write = (level, event, fields) => {
    if (ORDER[level] < threshold) return;
    const record = { stage, event, level };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) record[key] = value;
      }
    }
    process.stderr.write(JSON.stringify(record) + "\n");
  };
  return {
    stage,
    quiet,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (childStage) => createLogger(childStage, { quiet }),
  };
}

/** A logger that swallows everything, for unit tests. */
export function nullLogger(stage = "test") {
  const noop = () => {};
  return { stage, quiet: true, debug: noop, info: noop, warn: noop, error: noop, child: () => nullLogger(stage) };
}
