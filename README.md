This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## RPP access roles

RPP access is controlled by comma-separated email lists:

- `AUTH_ADMIN_EMAILS`: full access, including RMS job registration and real external notifications.
- `AUTH_OPERATOR_EMAILS`: target/settings edits, approvals, candidate generation, and CSV exports.
- `AUTH_VIEWER_EMAILS`: read-only access.
- `AUTH_ALLOWED_EMAILS`: legacy compatibility; listed users are treated as operators.

`n.nb0912@gmail.com` remains the default administrator when `AUTH_ADMIN_EMAILS` is unset. Human-operated RPP APIs enforce the role inside each route in addition to the Auth.js proxy. RPP-only role accounts are denied outside `/rpp` and `/api/rpp/*`; existing non-RPP access remains controlled by `AUTH_ALLOWED_EMAILS`. `sync-snapshot` and `exclusion-jobs` remain machine-only APIs protected by their existing Bearer tokens.
