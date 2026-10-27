// Moved to michi-runtime (runtime/src/core/eventQueue.ts). `export =` keeps
// this path the same module object as the package path, so test stubs still apply.
import m = require('michi-runtime/internal/core/eventQueue');
export = m;
