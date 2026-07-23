# Sketchware Pro + Turso Database Bridge

## جسر ديناميكي بين Sketchware Pro و Turso Database

هذا المشروع هو **API ديناميكي** يعمل على Vercel (مجاني) كجسر بين تطبيق Sketchware Pro وقاعدة بيانات Turso السحابية.

### الفكرة الأساسية

> التطبيق (Sketchware) هو من يتحكم بالكامل — يحدد الجدول، الحقول، العملية، والبيانات. الخادم الوسيط ينفذ فقط ما يطلبه التطبيق.

### المميزات

- 18 إجراء متاح (إضافة، جلب، تحديث، حذف، بحث، عد، ترتيب، وغيرها)
- يعمل مع أي جدول وأي حقول — بدون تعديل الكود
- دعم INSERT دفعة واحدة (Batch)
- دعم استعلامات SQL مخصصة
- حماية بمفتاح API اختياري
- حماية من SQL Injection (تنظيف المدخلات + Parameter Binding)
- CORS مفتوح لجميع المصادر
- مجاني بالكامل على Vercel + Turso Free Tier

### هيكل المشروع

```
sketchware-turso-bridge/
├── api/
│   └── index.js          ← الكود البرمجي الرئيسي (API ديناميكي)
├── package.json          ← تبعيات المشروع
├── vercel.json           ← إعدادات Vercel
├── .gitignore            ← ملفات مستبعدة
└── README.md             ← هذا الملف
```

### التبعيات

- `@libsql/client` — عميل الاتصال بقاعدة بيانات Turso (libSQL)

### النشر على Vercel

1. ارفع المشروع إلى GitHub
2. استورد المشروع في Vercel
3. أضف المتغيرات البيئية:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `APP_SECRET_KEY` (اختياري)
4. اضغط Deploy

### الاستخدام من Sketchware Pro

استخدم مكون `RequestNetwork` مع طريقة `POST` وأرسل JSON Body يحتوي على:
- `action`: نوع العملية
- `table`: اسم الجدول
- الحقول المطلوبة حسب العملية

راجع ملف `api-reference-table.md` للأمثلة الكاملة.
