# Michi · Touch study 01

An independent, interactive iOS-inspired exploration of two ideas: pull open the thought tree, and long-press a semantic block to branch or comment.

## Run

From the repository root:

```sh
npm install --prefix prototypes/michi-touch --workspaces=false --ignore-scripts
npm start --prefix prototypes/michi-touch
```

Open <http://localhost:4177>. The static server binds to `0.0.0.0`, so a phone on the same local network can open `http://<computer-LAN-IP>:4177`. Set `PORT` to choose another port. The server serves only the application files, sample photo and two Three.js bundles listed in `server.mjs`.

## Try

- Click the top-right tree control, or pull it down and left. Reverse the drag before releasing to change your mind.
- Drag the tree to pan; pinch to zoom. The plus/minus/fit controls work with a mouse. A trackpad pans; Ctrl/Cmd + wheel zooms.
- Tap a tree card to enter that page. Swipe the bottom title left/right to switch immediately to the next/previous page in creation order.
- Hold a paragraph, user message, image, code block, or table cell for 420 ms. Movement over 9 px cancels the hold so scrolling can win. A press within 32 px of content selects the nearest block.
- Choose **Branch**, name the thought, and enter a new page carrying its exact source excerpt and parent relationship.
- Choose **Comment** to leave a note. The count next to the original block reopens its comments.
- Type in the composer to add a local sample message. Both the message and the clearly marked sample reply can be branched.
- Expand the canvas on desktop, or use the full-screen responsive mobile layout. Reset clears only this prototype's browser data after a confirmation.

Keyboard: Tab between blocks, Space/Enter to select, Escape to dismiss; tree arrows pan, +/- zoom, 0 fits. Dialogs trap Tab and restore focus.

## Implementation and boundaries

`tree.js` uses a real Three.js WebGL scene: orthographic camera, rounded card meshes, Bézier tube edges, momentum panning and pinch scaling. DOM text tracks the geometry for crisp Chinese typography and accessible buttons. If WebGL cannot initialize, a labelled DOM/SVG fallback remains usable. Hidden trees stop rendering.

`app.js` owns the prototype's local state and interruptible spring animations. State uses the isolated `michi-touch-study-v1` localStorage key. Existing Michi state, databases, runtime adapters and production routes are not imported or modified. It does not call an AI provider. This intentionally isolated use of localStorage is not a proposed replacement for Michi's durable backend.

The interface uses system fonts, semantic color tokens, rounded materials, reduced-motion/transparency/contrast preferences, and a visual-viewport adjustment for mobile keyboards. Browser vibration is optional; Safari on iOS does not provide native haptic feedback through this API.

This is a web interaction prototype inspired by iOS conventions. Physical iPhone/Safari behavior, native haptics and native context-menu parity have not been validated.

## Validation

See [evidence/verification.md](evidence/verification.md) for browser findings and screenshot receipts. No production build or full Michi suite is needed for this independent static surface.

Assets: the sample mountain photo is downloaded from [Unsplash](https://images.unsplash.com/photo-1464822759023-fed622ff2c3b). Three.js 0.180.0 is pinned in the local package/lockfile under its MIT license. All runtime assets are local after installation.
