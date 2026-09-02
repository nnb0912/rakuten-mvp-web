import { signIn } from "@/auth";

export default function LoginPage() {
  return (
    <main className="login-shell">
      <section className="login-card">
        <p className="eyebrow">Rakuten MVP</p>
        <h1>ログイン</h1>
        <p>許可されたGoogleアカウントのみアクセスできます。</p>
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button className="primary-button" type="submit">Googleでログイン</button>
        </form>
        <small>許可されたGoogleアカウントでログインしてください。</small>
      </section>
    </main>
  );
}
