# Michi OpenAI Build Week Readiness

Updated: July 20, 2026 (JST)

Deadline: July 22, 2026 at 9:00 AM JST (July 21 at 5:00 PM PT)

Recommended track: **Developer Tools**

## Readiness table

| Needed | Build Week requirement | Current status | Evidence already available | What remains |
|---|---|---:|---|---|
| Entrant eligibility | Adult or authorized representative in an API-supported country, with no disqualifying conflict | ⚪ Confirm personally | Japan is generally supported | Confirm age, residence, authority to submit, ownership, and conflict conditions |
| Devpost registration | Register for the hackathon before the deadline | ✅ Ready | The prior audit found the logged-in account registered | No action unless account details changed |
| Devpost project entry | Create and complete a Devpost project submission | ❌ Missing | The prior audit found no project draft | Create the project and fill every required field |
| Working project | Project must install and work as shown | ✅ Ready | The production build passed in the prior audit | Re-run a final smoke test on the exact release shown to judges |
| Eligible track | Submit under an appropriate category | 🟡 Recommended | Michi is an agentic, branching workspace with Codex integration | Select **Developer Tools** in Devpost; Work & Productivity is a secondary fit |
| Codex use | Project must be built using Codex | ✅ Strong evidence | The codebase contains substantial Codex runtime, protocol, approval, tool, and session support | Summarize the most important Codex-assisted implementation work in the submission |
| GPT-5.6 use | Demonstrate meaningful GPT-5.6 use | 🟡 Evidence available, packaging needed | ChatGPT app records reportedly show GPT-5.6 work on Michi during the submission period | Capture clear screenshots or video evidence and explain the model's concrete contribution |
| New work during the submission period | Pre-existing projects must be meaningfully extended after July 13 | ✅ Strong, documentation needed | Git history contains extensive post-July 13 work | Add a dated before/after summary with representative commits or features |
| Project description | Explain the problem, audience, features, and how the product works | 🟡 Source material ready | The existing README provides positioning, features, and setup information | Turn it into a concise Devpost narrative centered on **ask → branch → compare → act with Codex → synthesize** |
| Public licensed repository | Supply a public licensed repository, or privately share it with the specified judges | 🟡 Implemented, uncommitted | Root `LICENSE` now contains ISC terms; root `package.json` declares `ISC` and credits Nan Yu | Review the legal choice, commit the license changes, and ensure the public repository includes them |
| README setup instructions | Include installation, setup, running instructions, and sample data if needed | ✅ Mostly ready | The README already documents installation, local development, configuration, and commands | Explicitly state that no sample data is required, if accurate |
| Build Week README section | Explain event-specific provenance and testing information | ❌ Missing | A section structure and required content have been designed in another branch | Add **OpenAI Build Week**, **Try the Project**, Codex/GPT-5.6 use, acceleration examples, key decisions, architecture, and limitations |
| Codex collaboration write-up | Explain where Codex accelerated work and where human decisions mattered | ❌ Missing | Strong implementation evidence exists in the repository and conversation history | Provide 3–5 concrete examples and identify the important product/technical decisions made by the team |
| Pre-existing versus eligible work disclosure | Distinguish work completed before and after July 13 | ❌ Missing | Commit history can support the distinction | Add the dated disclosure to the README or Devpost description |
| Demo video | Public YouTube video under three minutes, with audio and a working-product demonstration | 🟡 Blueprint ready | A detailed 2:30–2:45 storyboard and narrative are ready | Record, edit, caption if possible, upload publicly, and verify the link |
| Demo narrative | Show the problem, working product, Codex, GPT-5.6, and final value | 🟡 Ready to record | Recommended flow: linear-chat problem → branch → compare → Codex task → map → synthesize | Choose one realistic scenario and pre-stage reliable prompts and outputs |
| Screenshots and visual assets | Supply compelling project media | 🟡 Partial | App icons and an Open Graph image exist | Capture clean product screenshots, especially branching, side-by-side comparison, map, and synthesis |
| Judge-accessible test path | Let judges try the product without rebuilding it | 🟡 Partial | Source installation instructions are available | Preferably publish a signed/notarized DMG or other downloadable release and write a short test path |
| Installation instructions for a developer tool | Explain how to install and start the product | ✅ Ready for macOS | The README includes a one-line installer and manual development instructions | Verify instructions against the final release artifact |
| Supported platforms | Clearly state supported environments | 🟡 Inferable, not explicit enough | Current materials indicate a macOS ARM64 desktop build and Node-based local development | Add a plainly labeled platform/support matrix and minimum versions |
| Codex `/feedback` session ID | Submit the session ID for the thread containing the largest core contribution | ❌ Missing | The procedure for obtaining it is known | Run `/feedback` in the best representative Codex thread, review it for secrets first, and save the returned ID |
| English materials | Provide English descriptions, instructions, and narration or translation | ✅ On track | Repository documentation is in English | Keep the Devpost entry, video narration, captions, and testing instructions in English |
| Originality, IP, and third-party rights | Own the submission and comply with dependency, trademark, media, and API terms | 🟡 Review needed | Dependency metadata is available and the project now has an ISC license file | Complete a final rights review; use only owned or licensed demo media and music |
| Final submission | Submit all required fields and working public links before the deadline | ❌ Not started | Requirements and assets are now mapped | Submit early, reopen the entry, and test every repository, release, video, and demo link while logged out |

## Updated assessment

| Area | Assessment |
|---|---|
| Product and technical implementation | **Strong** |
| Evidence of meaningful in-window work | **Strong but not yet narrated** |
| Codex integration and provenance | **Strong** |
| GPT-5.6 compliance | **Evidence appears available; needs explicit packaging** |
| Licensing | **Implemented locally; needs review and commit** |
| Event-specific README | **Outlined but not added** |
| Demo video | **Storyboard ready; recording missing** |
| Judge accessibility | **Needs a downloadable release or equally simple test path** |
| Devpost submission | **Not started** |
| Overall readiness | **About 65–70%** |

## Critical path

1. Confirm and capture meaningful GPT-5.6 evidence.
2. Obtain the representative Codex `/feedback` session ID.
3. Add the Build Week section and dated new-work disclosure to the README.
4. Review and commit the ISC license changes.
5. Publish a judge-friendly release and verify the install path.
6. Record and upload the sub-three-minute narrated demo.
7. Create the Devpost project, complete all fields, and verify every public link.

## Recommended demo spine

Use one realistic task and show this complete transformation:

> Ask GPT-5.6 → branch into competing directions → compare branches side by side → use Codex for a concrete agentic task → reveal the conversation map → synthesize the strongest results.

The video should explicitly distinguish two claims: GPT-5.6 and Codex operating inside the demonstrated workflow, and Codex/GPT-5.6 helping build or refine Michi during the eligible period.
