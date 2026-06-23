# Prototype (names TBD)

Pre-launch landing page. Visible brand names are tokenized as `{{APP}}` (product) and `{{STUDIO}}` (company) — to be filled in once decided.

## Stack
| Layer | Tech |
|---|---|
| Frontend | GitHub Pages (custom domain) |
| Backend | Cloudflare Workers |
| Database | Cloudflare D1 |
| Email | Resend |
| CI/CD | GitHub Actions (auto-deploy on `workers/**` push) |

## Notes
- Fill `{{APP}}` / `{{STUDIO}}` across the HTML once names are chosen.
- Some live resource names (Cloudflare Worker / D1, GitHub repo, custom domain, email) still carry legacy labels; these are account-level and renamed at migration.
