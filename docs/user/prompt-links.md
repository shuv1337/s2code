# Prompt links

A prompt link opens S2Code with a prefilled draft—useful for sharing prompts or adding one-click fixes in pull request comments.

Links **never** auto-send or change your permission mode, branch, or worktree. They only open a draft for you to review and send.

## Create a link

- **From the composer**: Open the command palette and choose **Copy prompt link** (or **Copy prompt link with repo and model** on GitHub projects).
- **From a sent message**: Click **Copy prompt link**.
- **By hand** (URL-encode the prompt, e.g. with `encodeURIComponent`). Use the S2Code deep link, or replace `s2code.example` with your configured web origin:

```text
s2code://new?prompt=Review%20the%20test%20coverage
https://s2code.example/new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
https://s2code.example/new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Description                                                       |
| ---------- | ----------------------------------------------------------------- |
| `prompt`   | Draft text (up to 8,000 characters). Required unless `pr` is set. |
| `repo`     | GitHub repository (`owner/name` or URL).                          |
| `provider` | Provider ID (e.g. `codex`, `claude`).                             |
| `model`    | Model ID or name for that provider.                               |
| `pr`       | GitHub pull request (`owner/name/123` or URL).                    |

## How links open

S2Code has no default hosted web client. When you configure one, it can offer to open a link in the app or in the current browser.

- **No `repo`**: Opens a no-project draft on your last-used machine.
- **`repo`**: Opens in your most recent project for that repo (or offers **Clone** / **Use without project**).
- **`provider` / `model`**: Applied if configured; otherwise falls back to your default with a notice.
- **`pr`**: Opens the thread linked to that PR, or prepares a new worktree draft on the PR branch after you confirm checkout.
- **Thread prompt link** (`https://s2code.example/<environment>/<thread>?prompt=…`): On your configured web origin, prefills that thread's composer and asks before overwriting an existing draft.

S2Code strips invisible characters (such as zero-width and hidden tag characters) and warns you if a prompt contained them.

## Share a thread

**Copy thread** copies a link that pastes into the composer as a thread chip. Without a hosted web client, it uses `t3-thread://v2/<environment>/<thread>`; with one, the link uses that client's web origin. Only someone connected to the machine running the thread can view it.
