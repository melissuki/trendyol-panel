#!/usr/bin/env node
/**
 * Yonetici parolasi icin bcrypt ozeti uretir.
 *
 *   npm run auth:hash
 *
 * Parola argüman olarak ALINMAZ - kabuk gecmisine (~/.zsh_history) dusmesin
 * diye calisirken sorulur. Cikti .env dosyasina yapistirilir; duz parola
 * hicbir dosyaya yazilmaz.
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const rl = readline.createInterface({ input: stdin, output: stdout });

const RULES = [
  [(p) => p.length >= 12, 'en az 12 karakter'],
  [(p) => /[a-z]/.test(p), 'en az bir küçük harf'],
  [(p) => /[A-Z]/.test(p), 'en az bir büyük harf'],
  [(p) => /\d/.test(p), 'en az bir rakam'],
  [(p) => /[^A-Za-z0-9]/.test(p), 'en az bir özel karakter'],
];

try {
  const username = (await rl.question('Yönetici kullanıcı adı: ')).trim();
  if (username.length < 3) {
    console.error('\n❌ Kullanıcı adı en az 3 karakter olmalı.');
    process.exit(1);
  }

  const password = await rl.question('Parola: ');
  const confirm = await rl.question('Parola (tekrar): ');

  if (password !== confirm) {
    console.error('\n❌ Parolalar eşleşmiyor.');
    process.exit(1);
  }

  const failed = RULES.filter(([test]) => !test(password)).map(([, label]) => label);
  if (failed.length > 0) {
    console.error(`\n❌ Parola yeterince güçlü değil. Gerekli: ${failed.join(', ')}.`);
    process.exit(1);
  }

  // cost=12: kaba kuvvet denemesini bilincli olarak yavaslatir (~250ms/deneme)
  const hash = await bcrypt.hash(password, 12);
  const jwtSecret = crypto.randomBytes(48).toString('base64url');

  console.log(`
✅ Hazır. Aşağıdaki satırları server/.env dosyanıza ekleyin.
   (JWT_SECRET'ı yalnızca ilk kurulumda üretin — değiştirirseniz
    açık olan tüm oturumlar düşer.)

ADMIN_USERNAME=${username}
ADMIN_PASSWORD_HASH=${hash}
JWT_SECRET=${jwtSecret}
JWT_EXPIRES_IN=8h

⚠️  Düz parolayı hiçbir dosyaya yazmayın; yalnızca yukarıdaki özet saklanır.
`);
} finally {
  rl.close();
}
