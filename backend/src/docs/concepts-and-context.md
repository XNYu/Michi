# Understand workspaces, branches and context

Applies to: ordinary Michi chats across registered runtimes; Custom Agent exceptions are identified below. Source checked: 2026-10-16. Native memory and context limits depend on the runtime/version.

## What belongs where?

| Term | Meaning | Example |
| --- | --- | --- |
| Backend | Machine/process storing state and running tools | Desktop backend or remote Linux server |
| Workspace | Project with a backend association and working folder | A repository or research directory |
| Thread / tree | Root conversation and its branches | Research into a product decision |
| Chat / node | Conversation at one point in a tree | A branch comparing two designs |
| Pane | View of a chat, Artifact or Run | Two investigations side by side |
| Map | Navigation through the active tree | Finding where a branch began |
| Overview | Branch journal of recorded progress | Catching up before reading the transcript |
| Digest | Synthesis connected to selected conversation sources | A research comparison |
| Artifact | Reusable material registered in the workspace | Requirements or a report |

A workspace can contain several trees. Switching trees changes your view; it does not combine every conversation into one agent context. Closing a pane does not delete its history or request cancellation.

## What does an agent see?

An agent receives the request, applicable instructions, session context and supplied references. Michi advertises available Artifacts and provides retrieval tools; the agent does not automatically read every file or every chat.

| Material | How to use it | Boundary |
| --- | --- | --- |
| Current conversation | Continue the same chat | Finite context window; compaction/reconstruction changes its representation |
| Another chat | Mention the node, or ask the agent to find and read it | A reference may contain a summary rather than the full transcript |
| Artifact | Mention its name with `@`, or request a read | Shelf presence is not full-content injection |
| Project file | Supply its path and request relevant sections | Must exist on the selected backend and be accessible |
| Workspace instructions | Use workspace Instructions for standing guidance | Native runtime instruction files can add rules |
| Crew Memory | Choose a mode before creating a Crew chat | Separate from transcripts, Artifacts and workspace instructions |
| Product documentation | Ask the agent to consult `michi_docs` | Reference, not live settings inspection |

Current node references inline short conversations; longer conversations use a summary and retrieval hint. If a detail matters, ask: “Read the original messages in that referenced chat and cite the relevant passage.” Available tools include `search_messages`, `read_node` and `read_node_overview`.

Artifact favorites/pins affect UI ordering. The send path injects explicit `@` references, not all favorites. The Artifact manifest advertises names/locations rather than every document's full contents.

## What does a branch inherit?

A branch starts a separate direction using selected conversation context. Compatible idle parents can use native fork where supported; other paths use textual context. Later parent messages do not automatically synchronize into an existing child.

Inherited context does not guarantee identical hidden provider state. Native Resume and Native Fork are independent. See `sessions-and-recovery` and `runtime-capabilities`.

Conversation branches do not automatically create Git branches or worktrees. Two agents editing the same folder can overlap. For isolated implementation, create separate Git worktrees and point separate workspaces at them; specify each agent's directory.

## Bring findings together

Use a reference when one chat needs another's material. Use Weave for a conversation based on selected chats. Use Digest for a source-connected synthesis with stale-source awareness. Use an Artifact for a document you want to reuse beyond the conversational flow.

These operations do not merge Git changes or resolve code conflicts. A digest is a synthesis, not an exact transcript. Inspect its sources or request original passages when wording/evidence matters.

## History, context and Memory

Michi history is the durable record. Model context is the material used for a particular request. Compaction summarizes model context; it is not a full-history export. Crew Memory is a separate long-term facility governed by Memory mode and upstream policies.

Crew offers Read & learn, Read only and Off. Defaults affect new chats; established chats keep their mode and forks inherit it. Off does not delete transcripts or necessarily erase stored native memories. Michi has no universal cross-runtime Memory store or memory-deletion button.

Put stable conventions in instructions, variable goals in the current request, and reusable material in Artifacts. Retrieve details as needed. Moving a long prompt to the system role alone does not guarantee lower latency.

## Why did it forget?

1. Identify the source: this chat, another branch, an Artifact, a file or native Memory.
2. Reference it explicitly and ask for the relevant original section.
3. Ask the agent to state the facts and sources before continuing.
4. If the source changed, read the current file or rebuild its synthesis.

Success check: the answer cites the actual source and incorporates the missing detail. Otherwise inspect tool availability and backend/path selection instead of repeatedly lengthening the prompt.

Related documents: `files-and-artifacts`, `common-workflows`, `sessions-and-recovery`, `crew`.
