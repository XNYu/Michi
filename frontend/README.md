# Michi Frontend

The frontend workspace contains Michi's React and Vite renderer. Shared protocol
code lives in `../shared`, while backend APIs and runtime integrations live in
`../backend`.

Run frontend commands from the repository root:

```bash
npm run frontend:dev
npm test -w frontend
npm run typecheck -w frontend
```

Generated production assets are written to `frontend/build/`.
