# Vercel — Add MONGODB_URI (Atlas) Environment Variable

This document shows two safe ways to add your Atlas connection string (`MONGODB_URI`) to a Vercel project: the Dashboard (recommended) and the Vercel CLI.

---

## 1) Dashboard (recommended)
1. Sign in at https://vercel.com and open your Project.
2. Go to **Settings → Environment Variables**.
3. Click **Add** (or **Add New**) and enter:
   - Key: `MONGODB_URI`
   - Value: paste your Atlas connection string (e.g. `mongodb+srv://...` or the non-SRV form). Do NOT put this in source control.
   - Environment: choose **Preview** and **Production** (and **Development** if you want it available to `vercel dev`).
4. Save the variable.
5. Trigger a redeploy (push to the repo or click **Deployments → New Deployment**) so the new variable is available to the running app.

## 2) Vercel CLI (alternative)
1. Install / login:

```powershell
npm i -g vercel
npx vercel login
```

2. Add the variable. The CLI will prompt you for the value:

```powershell
npx vercel env add MONGODB_URI production
npx vercel env add MONGODB_URI preview
npx vercel env add MONGODB_URI development
```

3. Verify:

```powershell
npx vercel env ls
```

4. Pull environment variables to local (optional):

```powershell
npx vercel env pull .env.local
```

> Note: The CLI approach is interactive — if you want to script it you can export `VERCEL_TOKEN` and use the Vercel API, but avoid placing secrets into checked-in files.

---

## Notes & troubleshooting
- Atlas IP access: for serverless hosts like Vercel it's common to allow access from anywhere (0.0.0.0/0) or to configure a private network/VPC peering. If you restrict Atlas to specific IPs, ensure Vercel's outbound addresses are allowed (or use VPC peering).
- SRV vs non-SRV: either `mongodb+srv://` or the non-SRV host list works. `db.js` supports SRV. If you previously used a non-SRV string, both are acceptable — keep your deployment `MONGODB_URI` consistent.
- After adding the env var: redeploy and check logs (Vercel Dashboard → Deployments → <latest> → Logs) or call your health endpoint `/api/health` to confirm.
- If deployments still can't connect: verify the value, check Atlas user credentials, and confirm network access.

---

If you want, I can run the `npx vercel env add` commands from here — I would need you to either run them locally or provide a `VERCEL_TOKEN` (avoid pasting tokens into chat). Tell me whether you'd like: `1) instructions only`, `2) prepare a one-line script you can run`, or `3) me to run the CLI (you will run it locally or provide secure token).`