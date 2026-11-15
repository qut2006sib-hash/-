import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ArrowLeft, Bus, LayoutDashboard, Loader2, MapPin, ShieldCheck } from "lucide-react";
import {
  getGetSessionQueryKey, getGetAuthOptionsQueryKey, useGetSession, useSignIn, useGetAuthOptions, useDemoSignIn, type SessionInfo,
} from "@workspace/api-client-react";
import { errorMessage, roleHome, ROLE_LABEL } from "@/lib/app";
import { DemoTag, ErrorState, SkeletonBlock } from "@/components/kit";
import { Logo } from "@/components/shell";

export default function Welcome() {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const session = useGetSession({ query: { queryKey: getGetSessionQueryKey() } });
  const signIn = useSignIn();
  const options = useGetAuthOptions({ query: { queryKey: getGetAuthOptionsQueryKey(), retry: 1, staleTime: 0 } });
  const demoSignIn = useDemoSignIn();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const signedIn = (s: SessionInfo) => {
    qc.clear();
    qc.setQueryData(getGetSessionQueryKey(), s);
    setPassword("");
    setLocation(roleHome(s.user?.role));
  };

  useEffect(() => {
    const u = session.data?.authenticated ? session.data.user : undefined;
    if (u) setLocation(roleHome(u.role));
  }, [session.data, setLocation]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    signIn.mutate(
      { data: { loginName: loginName.trim(), password } },
      {
        onSuccess: signedIn,
        onError: (err) => { setError(errorMessage(err)); setPassword(""); },
      },
    );
  };

  return (
    <div className="min-h-[100dvh]">
      <div className="relative overflow-hidden bg-basalt text-limestone">
        <div className="mx-auto max-w-3xl px-5 pb-14 pt-6">
          <div className="flex items-center justify-between">
            <Logo light />
            <DemoTag text="نسخة عرض — بيانات تجريبية" className="border-limestone/30 bg-transparent text-limestone/80" />
          </div>
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
            className="mt-12 font-display text-[2.6rem] font-bold leading-[1.1] tracking-tight sm:text-6xl"
          >
            سرفيسنا
            <br />
            <span className="text-mandarin">على خطّك</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }} className="mt-4 max-w-md text-limestone/75">
            على خط الوعر ↔ وسط حمص: نقول لك أين تقف، والسائق يعرف أنك تنتظره في اتجاهه.
          </motion.p>
          <div className="mt-8 flex items-center gap-2 text-xs text-limestone/60">
            <span className="h-2 w-2 rounded-full bg-mandarin" /> الوعر
            <span className="ablaq h-1.5 flex-1 rounded-full opacity-80" />
            وسط حمص <span className="h-2 w-2 rounded-full bg-teal" />
          </div>
        </div>
        <div className="ablaq h-2" />
      </div>

      <div className="mx-auto -mt-6 max-w-3xl px-5 pb-16">
        <div className="rounded-3xl border border-basalt/10 bg-card p-5 shadow-[0_20px_40px_-24px_#1e1b1866]">
          <h2 className="font-display text-xl font-bold">ادخل بحساب تجريبي</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {options.data?.demoMode
              ? "اختَر حساب راكب أو سائق أو إدارة وجرّب التطبيق مباشرة، بدون كلمة مرور."
              : "استخدم اسم الدخول وكلمة المرور المخصّصين لك."}
          </p>

          {options.isLoading && <SkeletonBlock className="mt-5 h-40" />}
          {options.isError && <ErrorState onRetry={() => options.refetch()} />}
          {options.data?.demoMode && (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {options.data.accounts.map((account) => {
                const Icon = account.role === "driver" ? Bus : account.role === "admin" ? LayoutDashboard : MapPin;
                const pending = demoSignIn.isPending && demoSignIn.variables?.data.loginName === account.loginName;
                return (
                  <button key={account.loginName} data-testid={`button-account-${account.loginName}`}
                    disabled={demoSignIn.isPending}
                    onClick={() => {
                      setError("");
                      demoSignIn.mutate({ data: { loginName: account.loginName } }, {
                        onSuccess: signedIn, onError: (err) => setError(errorMessage(err)),
                      });
                    }}
                    className="flex w-full items-center gap-3 rounded-2xl border border-basalt/10 bg-chalk p-4 text-right transition hover:border-teal disabled:opacity-60">
                    <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${account.role === "passenger" ? "bg-mandarin text-basalt" : account.role === "driver" ? "bg-teal text-chalk" : "bg-basalt text-limestone"}`}>
                      <Icon className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold">{account.name}</span>
                      <span className="block text-xs text-muted-foreground">{ROLE_LABEL[account.role]}</span>
                    </span>
                    {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowLeft className="h-5 w-5" />}
                  </button>
                );
              })}
              {!options.data.accounts.length && <p role="alert" className="text-sm text-brick">لا توجد حسابات عرض مفعّلة. يلزم تشغيل إعداد الحسابات التجريبية.</p>}
            </div>
          )}
          {options.data && !options.data.demoMode && <form className="mt-5 space-y-4" onSubmit={submit}>
            <div>
              <label htmlFor="login-name" className="mb-1.5 block text-sm font-bold">اسم الدخول</label>
              <input id="login-name" data-testid="input-login-name" autoComplete="username" autoCapitalize="none" spellCheck={false}
                required maxLength={64} value={loginName} onChange={(e) => setLoginName(e.target.value)}
                dir="ltr" className="w-full rounded-2xl border border-basalt/20 bg-chalk px-4 py-3 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/30" />
            </div>
            <div>
              <label htmlFor="login-password" className="mb-1.5 block text-sm font-bold">كلمة المرور</label>
              <input id="login-password" data-testid="input-password" type="password" autoComplete="current-password"
                required maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)}
                dir="ltr" className="w-full rounded-2xl border border-basalt/20 bg-chalk px-4 py-3 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/30" />
            </div>
            <button type="submit" disabled={signIn.isPending} data-testid="button-login"
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-mandarin px-4 py-3 font-bold text-basalt transition hover:brightness-95 disabled:opacity-60">
              {signIn.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowLeft className="h-5 w-5" />}
              {signIn.isPending ? "جارٍ تسجيل الدخول…" : "تسجيل الدخول"}
            </button>
          </form>}
          {error && <p role="alert" className="mt-4 rounded-2xl bg-brick-soft p-3 text-sm text-brick" data-testid="login-error">{error}</p>}
          <div className="mt-5 flex items-start gap-2 rounded-2xl bg-limestone p-3 text-xs text-basalt/75">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            لا نجمع أرقام هواتف. اسم الراكب المختصر يظهر لسائقه بعد قبول الطلب فقط.
          </div>
        </div>
      </div>
    </div>
  );
}
