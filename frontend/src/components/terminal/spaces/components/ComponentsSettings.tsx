import React, { useState } from 'react';
import { useChatProjects } from '../../../../state/chatStore';
import { ComponentLibrary } from './ComponentLibrary';
import { BuiltinComponents } from './BuiltinComponents';

/** Each library belongs to a workspace; never silently mix local and remote components. */
export function ComponentsSettings() {
  const { projects, activeProject } = useChatProjects();
  const workspaces = projects.filter(project => !project.deletedAt && !project.archivedAt && (!project.backendConnectionId || project.backendConnectionId === 'local'));
  const [selected, setSelected] = useState(activeProject?.id ?? '');
  const workspace = workspaces.find(project => project.id === selected) ?? workspaces[0];
  return <div className="components-settings">
    <p className="component-catalog__description">Reusable blocks for your pages. Workspace components stay with the workspace where they were created.</p>
    {workspace ? <>
      <label className="components-settings__workspace">Workspace<select aria-label="Workspace" className="ui-select" value={workspace.id} onChange={event => setSelected(event.target.value)}>
        {workspaces.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <ComponentLibrary workspaceId={workspace.id} connectionId="local" />
    </> : <><BuiltinComponents /><p className="component-catalog__description">Create a local workspace to save your own components.</p></>}
  </div>;
}
