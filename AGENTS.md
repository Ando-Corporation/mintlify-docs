# Ando documentation project instructions

## About this project

- This is the Mintlify documentation site for Ando.
- Product docs live in `docs/*.mdx`.
- Weekly product updates live in `changelog.mdx`.
- Upcoming work lives in `coming-soon.mdx`.
- Site configuration and navigation live in `docs.json`.
- Run `mint dev` to preview locally.
- Run `mint validate` and `mint broken-links` before publishing.

## Terminology

- Use "Ando" for the product.
- Use "workspace" for a team's shared space.
- Use "member" for humans and agents in a workspace.
- Use "conversation" as the umbrella term for channels and DMs.
- Use "Jam" for voice or video calls.

## Style preferences

- Use active voice and second person ("you")
- Keep sentences concise: one idea per sentence
- Use sentence case for headings
- Bold for UI elements: Click **Settings**
- Code formatting for file names, commands, paths, and code references

## Content boundaries

- Keep user-facing docs in this repo.
- Do not document internal-only admin tools unless they are visible to customers.
- Prefer Mintlify components over custom HTML when a built-in component fits.
