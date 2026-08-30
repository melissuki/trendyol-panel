import { useEffect, useState } from 'react';
import Spinner from './Spinner.jsx';
import { fetchAuthStatus } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * YONETICI GIRIS EKRANI
 *
 * Guvenlik notlari:
 *  - Parola yalnizca POST govdesinde gider (URL'de/query string'de ASLA).
 *  - Hata mesaji sunucudan geldigi gibi gosterilir; kullanici adi mi parola mi
 *    yanlis bilgisi kasitli olarak verilmez.
 *  - Basarisiz denemeler sunucuda hiz sinirina takilir (kaba kuvvet korumasi).
 */
export default function LoginScreen() {
  const { login, sessionMessage } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [configured, setConfigured] = useState(null);

  // Sunucuda yonetici hesabi tanimli mi? Degilse kurulum yonergesi gosterilir.
  useEffect(() => {
    fetchAuthStatus()
      .then((data) => setConfigured(data.configured))
      .catch(() => setConfigured(null));
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      await login({ username: username.trim(), password });
    } catch (err) {
      setError(err.message || 'Giriş yapılamadı.');
      setPassword('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-trendyol-500 text-2xl font-black text-white">
            T
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800">Trendyol Satış Analiz Paneli</h1>
            <p className="mt-1 text-sm text-slate-500">Devam etmek için yönetici girişi yapın</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4 p-6" noValidate>
          {sessionMessage && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {sessionMessage}
            </p>
          )}

          {configured === false && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <p className="font-semibold">Yönetici hesabı henüz tanımlanmamış.</p>
              <p className="mt-1">
                Sunucuda <code className="rounded bg-amber-100 px-1 font-mono text-xs">npm run auth:hash</code>{' '}
                komutunu çalıştırıp çıktıyı <code className="rounded bg-amber-100 px-1 font-mono text-xs">server/.env</code>{' '}
                dosyasına ekleyin.
              </p>
            </div>
          )}

          <div>
            <label htmlFor="username" className="label">
              Kullanıcı Adı
            </label>
            <input
              id="username"
              name="username"
              type="text"
              className="input"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label htmlFor="password" className="label">
              Parola
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                className="input pr-20"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 px-3 text-xs font-semibold text-slate-500 hover:text-slate-700"
                tabIndex={-1}
              >
                {showPassword ? 'Gizle' : 'Göster'}
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="btn-primary w-full justify-center"
            disabled={isSubmitting || !username.trim() || !password}
          >
            {isSubmitting ? (
              <>
                <Spinner />
                Giriş yapılıyor…
              </>
            ) : (
              'Giriş Yap'
            )}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-400">
          Trendyol API anahtarları yalnızca sunucuda tutulur ve tarayıcıya hiçbir zaman gönderilmez.
        </p>
      </div>
    </div>
  );
}
