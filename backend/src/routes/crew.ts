import { Router } from 'express';
import { isCrewMemoryMode } from 'michi-shared';
import { defaultCrewMemory, saveDefaultCrewMemory } from '../agents/crew/crewMemory';
import { getNode, getWorkspace } from '../services/dbRepository';
import { crewIntegrationStatus } from '../agents/crew/crewLaunch';

export function crewRoutes(): Router {
    const router = Router();
    router.use('/crew', (req, res, next) => {
        if (process.env.MICHI_CLOUD === '1' && !req.user?.id) return res.status(401).json({ error: 'Authentication required' });
        next();
    });
    router.get('/crew/status', (_req, res) => res.json(crewIntegrationStatus()));
    router.get('/crew/memory', (req, res) => {
        const nodeId = req.query.nodeId;
        let mode = null;
        if (nodeId !== undefined) {
            if (typeof nodeId !== 'string') return res.status(400).json({ error: 'Invalid nodeId' });
            const node = getNode(nodeId);
            if (!node || node.deleted_at || (process.env.MICHI_CLOUD === '1'
                && (!req.user?.id || getWorkspace(node.workspace_id)?.owner_user_id !== req.user.id))) {
                return res.status(404).json({ error: 'Chat not found' });
            }
            mode = isCrewMemoryMode(node.crew_memory_mode) ? node.crew_memory_mode : null;
        }
        return res.json({ defaultMode: defaultCrewMemory(req.user?.id), mode });
    });
    router.post('/crew/memory', (req, res) => {
        if (!isCrewMemoryMode(req.body?.defaultMode)) return res.status(400).json({ error: 'Invalid Crew memory mode' });
        saveDefaultCrewMemory(req.body.defaultMode, req.user?.id);
        return res.json({ defaultMode: req.body.defaultMode });
    });
    return router;
}
