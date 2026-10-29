// Minimal ambient shim for `three`.
//
// GraphCanvas3D previously did `const THREE = require('three')`, which typed
// THREE as `any`. We switched to a top-level ESM `import * as THREE from 'three'`
// so the app shares the SAME Three.js module instance as react-force-graph-3d
// (mixing CJS require + ESM import loaded Three twice and triggered three's
// "Multiple instances of Three.js being imported" warning).
//
// `three` ships no bundled types and @types/three is not installed; this shim
// keeps the exact (untyped) posture the require() call had, so the import
// resolves without re-type-checking the existing Three.js drawing code.
// Remove this file if @types/three is ever added.
declare module 'three'
