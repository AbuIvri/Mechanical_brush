# הפעלה ורישוי — המכחול המכני

מערכת הפעלה **אונליין**: כל קוד תקף ל**מחשב אחד** וחד-פעמי. בהפעלה הקוד נקשר
למחשב; שימוש באותו קוד במחשב אחר נחסם. האפליקציה מקבלת **קבלה חתומה** (Ed25519)
שנבדקת בכל הפעלה — כך שהעתקת קבצים למחשב אחר לא תעבוד.

הרכיבים:
- `server/activation/` — Cloudflare Worker + KV (מאגר הקודים).
- `scripts/gen-codes.mjs` — מחולל מאגר קודים.
- `electron/license/LicenseManager.ts` — צד האפליקציה (מזהה-מחשב, אקטיבציה, אימות).
- `license-private-key.pem` — מפתח החתימה (**סודי! לגבות, לא להפיץ**).

---

## הקמה חד-פעמית (אתה, המפתח)

### 1. התקנת wrangler והתחברות
```bash
cd "server/activation"
npx wrangler login
```

### 2. יצירת מאגר KV
```bash
npx wrangler kv namespace create CODES
```
העתק את ה-`id` שחוזר ל-`server/activation/wrangler.toml` (בשדה `id`).

### 3. הזרקת מפתח החתימה כ-Secret
מתוך `server/activation/`:
```bash
node -e "console.log(require('crypto').createPrivateKey(require('fs').readFileSync('../../license-private-key.pem')).export({type:'pkcs8',format:'der'}).toString('base64'))" | npx wrangler secret put SIGN_KEY_PKCS8_B64
```
(זה לוקח את המפתח הפרטי המקומי והופך אותו ל-Secret בשרת — המפתח עצמו לא נשמר בקוד.)

### 4. פריסת השרת
```bash
npx wrangler deploy
```
תקבל כתובת כמו `https://mbrush-activation.<תת-דומיין>.workers.dev`.

### 5. חיבור האפליקציה לשרת
ב-`electron/license/LicenseManager.ts`, עדכן את `ACTIVATION_URL` לכתובת שקיבלת
(או בנה עם `MBRUSH_ACTIVATION_URL=https://... npm run dist`).

### 6. בנייה מחדש
```bash
npm run dist -- --mac --win
```

---

## הנפקת קודים וחלוקה

```bash
# 100 קודים
node scripts/gen-codes.mjs 100

# עם תווית ותוקף שנה
node scripts/gen-codes.mjs 100 --name "מחזור ראשון" --days 365
```
נוצרים שני קבצים תחת `license-codes/`:
- `codes-*.txt` — רשימת הקודים לחלוקה לעוקבים.
- `kv-seed-*.json` — להעלאה למאגר:

```bash
cd server/activation
npx wrangler kv bulk put "../../license-codes/kv-seed-XXXX.json" --binding CODES --remote
```

מאותו רגע — כל קוד ברשימה תקף, חד-פעמי, וננעל למחשב הראשון שמפעיל אותו.

---

## תפעול שוטף
- **לראות מי הפעיל קוד**: `npx wrangler kv key get "code:MB-XXXX-XXXX-XXXX" --binding CODES --remote`
- **לבטל/לאפס קוד** (לשחרר ממחשב): `npx wrangler kv key put "code:MB-..." '{"name":null,"exp":null}' --binding CODES --remote`
- **להוסיף קודים**: הרץ שוב את המחולל והעלה את ה-kv-seed החדש.

## אבטחה
- שמור על `license-private-key.pem` ועל ה-Secret. דליפה = אפשרות לזייף קבלות.
- הקודים ב-KV הם הרשימה הקובעת — רק קוד שקיים שם יעבוד.
