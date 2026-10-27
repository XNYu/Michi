// Moved to michi-runtime (runtime/src/core/executableLookup.ts). `export =` keeps
// this path the same module object as the package path, so test stubs still apply.
import m = require('michi-runtime/internal/core/executableLookup');
export = m;
