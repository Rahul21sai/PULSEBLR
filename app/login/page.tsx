'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';

export default function LoginPage() {
  const [loading, setLoading] = useState(false);

  const handleGoogleSignIn = async () => {
    setLoading(true);
    await signIn('google', { callbackUrl: '/' });
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7] flex items-center justify-center px-5">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold tracking-tight text-[#1D1D1F] mb-2">PulseBLR</h1>
          <p className="text-[#86868B] text-[17px]">Bangalore's tech event pulse</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-[20px] shadow-[0_10px_40px_rgba(0,0,0,0.06)] p-8">
          <h2 className="text-[24px] font-semibold text-[#1D1D1F] leading-tight tracking-tight mb-2">
            Sign in
          </h2>
          <p className="text-[#86868B] text-[14px] mb-8">
            Track AI, Fintech, and Networking events across Bangalore.
          </p>

          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 bg-white border border-[#c1c6d6] rounded-full py-3.5 px-6 text-[14px] font-medium text-[#1D1D1F] hover:bg-[#f3f3f5] active:scale-[0.98] transition-all duration-150 shadow-sm disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="w-5 h-5 border-2 border-[#0071E3] border-t-transparent rounded-full animate-spin" />
            ) : (
              /* Google "G" SVG */
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            )}
            {loading ? 'Signing in…' : 'Continue with Google'}
          </button>

          <p className="text-center text-[12px] text-[#86868B] mt-6 leading-relaxed">
            By signing in you agree to our{' '}
            <a href="#" className="text-[#0071E3] hover:underline">Terms</a>
            {' '}and{' '}
            <a href="#" className="text-[#0071E3] hover:underline">Privacy Policy</a>.
          </p>
        </div>

        {/* Hero tagline */}
        <div className="mt-10 text-center space-y-3">
          {[
            { icon: 'rss_feed', text: 'Curated tech events feed' },
            { icon: 'analytics', text: 'Kanban event tracker' },
            { icon: 'calendar_today', text: 'Calendar view with dot indicators' },
          ].map(({ icon, text }) => (
            <div key={icon} className="flex items-center justify-center gap-2 text-[#86868B] text-[14px]">
              <span className="material-symbols-outlined text-[18px] text-[#0071E3]">{icon}</span>
              <span>{text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
