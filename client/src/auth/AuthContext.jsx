import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { fetchMe, getToken, login as apiLogin, logout as apiLogout, onUnauthorized } from '../api/client.js';

/**
 * OTURUM DURUMU
 * Uygulama acilirken elde jeton varsa /api/auth/me ile dogrulanir; jeton
 * suresi dolmus ya da sunucu tarafinda gecersiz kilinmissa kullanici
 * dogrudan giris ekranina dusulur.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('checking'); // checking | anonymous | authenticated
  const [sessionMessage, setSessionMessage] = useState(null);

  // Acilista mevcut jetonu dogrula
  useEffect(() => {
    const controller = new AbortController();
    if (!getToken()) {
      setStatus('anonymous');
      return () => controller.abort();
    }
    fetchMe({ signal: controller.signal })
      .then(({ user: me }) => {
        setUser(me);
        setStatus('authenticated');
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setUser(null);
        setStatus('anonymous');
      });
    return () => controller.abort();
  }, []);

  // Herhangi bir istekte 401 gelirse oturumu dusur
  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setStatus('anonymous');
        setSessionMessage('Oturumunuz sona erdi. Lütfen tekrar giriş yapın.');
      }),
    [],
  );

  const login = useCallback(async (credentials) => {
    const data = await apiLogin(credentials);
    setUser(data.user);
    setStatus('authenticated');
    setSessionMessage(null);
    return data;
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setStatus('anonymous');
    setSessionMessage(null);
  }, []);

  const value = useMemo(
    () => ({ user, status, login, logout, sessionMessage, clearSessionMessage: () => setSessionMessage(null) }),
    [user, status, login, logout, sessionMessage],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth yalnızca <AuthProvider> içinde kullanılabilir.');
  return context;
}
