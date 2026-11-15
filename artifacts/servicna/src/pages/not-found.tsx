import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="ablaq h-2 w-40 rounded-full" />
      <h1 className="font-display text-5xl font-bold">ضلّينا الطريق</h1>
      <p className="max-w-xs text-muted-foreground">هذا الموقف ليس على خطّنا. ارجع إلى البداية واختر وجهتك من جديد.</p>
      <Link href="/" className="rounded-full bg-basalt px-5 py-2.5 font-bold text-limestone" data-testid="link-go-home">إلى البداية</Link>
    </div>
  );
}
