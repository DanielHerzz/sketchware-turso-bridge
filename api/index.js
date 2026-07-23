const { createClient } = require('@libsql/client');

// ============================================
// إعداد الاتصال بقاعدة بيانات Turso
// ============================================
const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ============================================
// مفاتيح الأمان
// ============================================
const APP_SECRET = process.env.APP_SECRET_KEY || '';

function verifyApiKey(headers) {
  if (!APP_SECRET) return true;
  return headers['x-api-key'] === APP_SECRET;
}

// ============================================
// دوال مساعدة
// ============================================

function cleanColName(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, '');
}

function cleanTableName(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, '');
}

async function executeSQL(sql, params = []) {
  try {
    const result = await client.execute({ sql, args: params });
    return {
      success: true,
      data: {
        columns: result.columns,
        rows: result.rows.map(row => {
          const obj = {};
          result.columns.forEach((col, i) => {
            obj[col.name] = row[i];
          });
          return obj;
        }),
        rowsAffected: result.rowsAffected,
        lastInsertRowid: result.lastInsertRowid
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function executeBatch(statements) {
  const results = [];
  try {
    for (const stmt of statements) {
      const result = await client.execute({
        sql: stmt.sql,
        args: stmt.args || []
      });
      results.push({
        success: true,
        data: {
          columns: result.columns,
          rows: result.rows.map(row => {
            const obj = {};
            result.columns.forEach((col, i) => {
              obj[col.name] = row[i];
            });
            return obj;
          }),
          rowsAffected: result.rowsAffected,
          lastInsertRowid: result.lastInsertRowid
        }
      });
    }
    return { success: true, data: results };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// التحقق من وجود جدول
async function tableExists(tableName) {
  try {
    const result = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      args: [tableName]
    });
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

// ============================================
// Vercel Serverless Function Handler
// ============================================
module.exports = async function handler(request, response) {
  
  // إعداد CORS
  response.setHeader('Access-Control-Allow-Credentials', true);
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  
  if (request.method === 'OPTIONS') {
    response.status(200).end();
    return;
  }

  // التحقق من مفتاح الأمان
  if (!verifyApiKey(request.headers)) {
    response.status(401).json({ success: false, error: 'مفتاح API غير صالح' });
    return;
  }

  // قراءة البيانات المرسلة
  let body = {};
  if (request.body) {
    if (typeof request.body === 'string') {
      try { body = JSON.parse(request.body); } catch (e) { body = {}; }
    } else {
      body = request.body;
    }
  }

  const action = body.action || request.query.action;
  const table = body.table || request.query.table;

  // ==========================================
  // 1. ping — اختبار الاتصال بالخادم
  // ==========================================
  // ماذا يفعل: يتأكد أن الخادم يعمل ومتصل بقاعدة البيانات
  // متى تستخدمه: عند تشغيل التطبيق للتأكد من أن كل شيء جاهز
  // ماذا ترجع: رسالة نجاح + اسم قاعدة البيانات + الوقت
  // مثال من Sketchware:
  //   action = ping
  // ==========================================
  if (action === 'ping') {
    response.json({
      success: true,
      message: 'الخادم يعمل بنجاح',
      database: 'Turso (libSQL)',
      timestamp: new Date().toISOString()
    });
    return;
  }

  // التحقق من وجود اسم الجدول
  if (!table && action !== 'ping' && action !== 'get_tables' && action !== 'raw_query' && action !== 'batch') {
    response.status(400).json({
      success: false,
      error: 'يجب إرسال اسم الجدول في الحقل "table"'
    });
    return;
  }

  if (table) {
    var cleanTable = cleanTableName(table);
    if (!cleanTable) {
      response.status(400).json({ success: false, error: 'اسم الجدول غير صالح' });
      return;
    }
  }

  // ==========================================
  // 2. create_table — إنشاء جدول جديد
  // ==========================================
  // ماذا يفعل: ينشئ جدول جديد في قاعدة البيانات
  // متى تستخدمه: عند تشغيل التطبيق لأول مرة لإنشاء الجداول
  // ماذا يرجع: نجاح أو خطأ
  // 
  // ** حل مشكلة التكرار: **
  // إذا الضغطت مرتين، لن يظهر خطأ! لأن SQL يستخدم
  // "CREATE TABLE IF NOT EXISTS" — يعني إذا الجدول موجود
  // يتجاهل العملية بدون أخطاء. آمن تماماً!
  //
  // ** حل مشكلة الأعمدة الإضافية: **
  // إذا أرسلت أعمدة جديدة والجدول موجود، سيضيفها تلقائياً
  // كـ "ALTER TABLE ADD COLUMN" إذا لم تكن موجودة
  // ==========================================
  if (action === 'create_table') {
    const columns = body.columns;
    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الأعمدة "columns"' });
      return;
    }

    // أولاً: إنشاء الجدول (إذا لم يكن موجود)
    const colDefs = columns.map(col => {
      const name = cleanColName(col.name);
      const type = String(col.type || 'TEXT').toUpperCase();
      const isPrimary = col.primaryKey ? ' PRIMARY KEY' : '';
      const isAutoIncrement = col.autoIncrement ? ' AUTOINCREMENT' : '';
      const isNotNull = col.notNull ? ' NOT NULL' : '';
      const isUnique = col.unique ? ' UNIQUE' : '';
      const isDefault = col.default !== undefined ? ` DEFAULT ${typeof col.default === 'string' ? `'${col.default}'` : col.default}` : '';
      return `${name} ${type}${isPrimary}${isAutoIncrement}${isNotNull}${isUnique}${isDefault}`;
    });

    const hasPrimary = columns.some(c => c.primaryKey);
    if (!hasPrimary) {
      colDefs.unshift('id INTEGER PRIMARY KEY AUTOINCREMENT');
    }

    const createSql = `CREATE TABLE IF NOT EXISTS ${cleanTable} (${colDefs.join(', ')})`;
    await executeSQL(createSql);

    // ثانياً: التحقق من الأعمدة وإضافة الناقصة (ALTER TABLE)
    try {
      const existingCols = await client.execute({ sql: `PRAGMA table_info(${cleanTable})` });
      const existingNames = existingCols.rows.map(r => r[1]); // index 1 = name

      for (const col of columns) {
        const colName = cleanColName(col.name);
        if (!existingNames.includes(colName)) {
          // هذا العمود غير موجود — أضفه
          const type = String(col.type || 'TEXT').toUpperCase();
          const isNotNull = col.notNull ? ' NOT NULL' : '';
          const isUnique = col.unique ? ' UNIQUE' : '';
          const isDefault = col.default !== undefined ? ` DEFAULT ${typeof col.default === 'string' ? `'${col.default}'` : col.default}` : '';
          const alterSql = `ALTER TABLE ${cleanTable} ADD COLUMN ${colName} ${type}${isNotNull}${isUnique}${isDefault}`;
          await client.execute({ sql: alterSql });
        }
      }

      response.json({
        success: true,
        message: 'تم إنشاء/تحديث الجدول بنجاح',
        data: { table: cleanTable, columns: columns.map(c => cleanColName(c.name)) }
      });
    } catch (error) {
      response.json({ success: false, error: error.message });
    }
    return;
  }

  // ==========================================
  // 3. drop_table — حذف جدول بالكامل
  // ==========================================
  // ماذا يفعل: يحذف الجدول وكل بياناته نهائياً
  // متى تستخدمه: نادراً — في لوحات التحكم الإدارية فقط
  // تحذير: لا يمكن التراجع! البيانات تضيع للأبد
  // مثال من Sketchware:
  //   action = drop_table
  //   table = جدول_قديم
  // ==========================================
  if (action === 'drop_table') {
    const sql = `DROP TABLE IF EXISTS ${cleanTable}`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 4. get_all — جلب جميع السجلات
  // ==========================================
  // ماذا يفعل: يجلب كل البيانات الموجودة في الجدول
  // متى تستخدمه: عند فتح صفحة تعرض قائمة بكل العناصر
  // ماذا يرجع: مصفوفة بكل السجلات (أعمدة + صفوف)
  // مثال من Sketchware:
  //   action = get_all
  //   table = users
  // ==========================================
  if (action === 'get_all') {
    // إذا الجدول غير موجود، ارجع رسالة واضحة بدل خطأ
    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { columns: [], rows: [], rowsAffected: 0, message: 'الجدول غير موجود (لا توجد بيانات)' } });
      return;
    }
    const sql = `SELECT * FROM ${cleanTable}`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 5. get_by_id — جلب سجل واحد بالـ ID
  // ==========================================
  // ماذا يفعل: يجلب سجل واحد فقط باستخدام رقمه
  // متى تستخدمه: عند فتح صفحة تفاصيل عنصر معين
  // ماذا يرجع: سجل واحد أو مصفوفة فارغة إذا لم يوجد
  // مثال من Sketchware:
  //   action = get_by_id
  //   table = users
  //   id = 5
  // ==========================================
  if (action === 'get_by_id') {
    const id = body.id;
    if (id === undefined || id === null) {
      response.status(400).json({ success: false, error: 'يجب إرسال قيمة "id"' });
      return;
    }
    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { columns: [], rows: [], rowsAffected: 0, message: 'الجدول غير موجود' } });
      return;
    }
    const sql = `SELECT * FROM ${cleanTable} WHERE id = ?`;
    const result = await executeSQL(sql, [id]);
    response.json(result);
    return;
  }

  // ==========================================
  // 6. get_where — جلب سجلات بشرط محدد
  // ==========================================
  // ماذا يفعل: يجلب سجلات محددة بناءً على شروط
  // متى تستخدمه: جلب مستخدمين بعمر معين، أو منتجات بقسم معين
  // يدعم: =, !=, >, <, >=, <=, LIKE, NOT LIKE
  // يدعم: LIMIT لتحديد عدد النتائج
  // مثال من Sketchware:
  //   action = get_where
  //   table = users
  //   where = [{"column": "age", "value": "18", "operator": ">="}]
  //   limit = 10
  // ==========================================
  if (action === 'get_where') {
    const where = body.where;
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { columns: [], rows: [], rowsAffected: 0, message: 'الجدول غير موجود' } });
      return;
    }

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = cleanColName(w.column);
      const op = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE'].includes(String(w.operator || '=').toUpperCase())
        ? String(w.operator || '=').toUpperCase() : '=';
      conditions.push(`${col} ${op} ?`);
      values.push(w.value);
    });

    const limit = body.limit ? ` LIMIT ${parseInt(body.limit)}` : '';
    const sql = `SELECT * FROM ${cleanTable} WHERE ${conditions.join(' AND ')}${limit}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 7. insert — إضافة سجل جديد (الطريقة المباشرة)
  // ==========================================
  // ماذا يفعل: يضيف سجل جديد إلى الجدول
  // متى تستخدمه: عند تسجيل مستخدم، إضافة منتج، نشر تعليق
  // 
  // ** حل مشكلة "الجدول غير موجود": **
  // إذا الجدول غير موجود، الخادم سينشئه تلقائياً!
  // يأخذ أسماء الحقول التي أرسلتها ويستخدمها كأعمدة
  // أنواع الأعمدة: إذا القيمة رقم = INTEGER، وإلا = TEXT
  //
  // الطريقة الأولى (مباشرة - الأسهل لـ Sketchware):
  //   action = insert
  //   table = users
  //   name = أحمد       ← يضاف كحقل
  //   email = a@b.com  ← يضاف كحقل
  //   uid = 12345      ← يضاف كحقل
  //
  // الطريقة الثانية (مغلفة):
  //   action = insert
  //   table = users
  //   data = {"name": "أحمد", "email": "a@b.com"}
  //
  // كلا الطريقتين تعملان!
  // ==========================================
  if (action === 'insert') {
    const reservedKeys = ['action', 'table', 'data', 'where', 'columns', 'id', 'query', 
                          'limit', 'orderBy', 'uniqueColumn', 'sql', 'params', 'statements'];
    const dataKeys = Object.keys(body).filter(k => !reservedKeys.includes(k));
    
    let data;
    if (body.data && typeof body.data === 'object' && Object.keys(body.data).length > 0) {
      data = body.data;
    } else if (dataKeys.length > 0) {
      data = {};
      dataKeys.forEach(k => { data[k] = body[k]; });
    } else {
      response.status(400).json({ success: false, error: 'يجب إرسال بيانات السجل' });
      return;
    }

    // ** حل ذكي: إذا الجدول غير موجود، أنشئه تلقائياً **
    const exists = await tableExists(cleanTable);
    if (!exists) {
      const colDefs = Object.keys(data).map(k => {
        const name = cleanColName(k);
        const val = data[k];
        const type = (typeof val === 'number' || /^\d+$/.test(String(val))) ? 'INTEGER' : 'TEXT';
        return `${name} ${type}`;
      });
      const createSql = `CREATE TABLE IF NOT EXISTS ${cleanTable} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs.join(', ')})`;
      await executeSQL(createSql);
    }

    const columns = Object.keys(data).map(c => cleanColName(c));
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => data[c]);
    const sql = `INSERT INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 8. batch_insert — إضافة عدة سجلات دفعة واحدة
  // ==========================================
  // ماذا يفعل: يضيف عدة سجلات في طلب واحد (أسرع وأوفر)
  // متى تستخدمه: عند استيراد بيانات أو تحميل عدة عناصر دفعة
  // مثال من Sketchware:
  //   action = batch_insert
  //   table = users
  //   data = [{"name": "أحمد"}, {"name": "محمد"}]
  // ==========================================
  if (action === 'batch_insert') {
    const dataArray = body.data;
    if (!dataArray || !Array.isArray(dataArray) || dataArray.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة البيانات في الحقل "data"' });
      return;
    }

    // إذا الجدول غير موجود، أنشئه تلقائياً
    const exists = await tableExists(cleanTable);
    if (!exists) {
      const colDefs = Object.keys(dataArray[0]).map(k => {
        const name = cleanColName(k);
        const val = dataArray[0][k];
        const type = (typeof val === 'number' || /^\d+$/.test(String(val))) ? 'INTEGER' : 'TEXT';
        return `${name} ${type}`;
      });
      const createSql = `CREATE TABLE IF NOT EXISTS ${cleanTable} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs.join(', ')})`;
      await executeSQL(createSql);
    }

    const columns = Object.keys(dataArray[0]).map(c => cleanColName(c));
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    
    try {
      const results = [];
      for (const item of dataArray) {
        const values = columns.map(c => item[c]);
        const result = await client.execute({ sql: insertSql, args: values });
        results.push({ lastInsertRowid: result.lastInsertRowid });
      }
      response.json({
        success: true,
        data: {
          rowsAffected: dataArray.length,
          insertedIds: results.map(r => r.lastInsertRowid)
        }
      });
      return;
    } catch (error) {
      response.json({ success: false, error: error.message });
      return;
    }
  }

  // ==========================================
  // 9. update — تحديث سجل موجود
  // ==========================================
  // ماذا يفعل: يعدّل بيانات سجل موجود
  // متى تستخدمه: عند تعديل اسم المستخدم أو تحديث حالة طلب
  // يحتاج: data (البيانات الجديدة) + where (لتحديد السجل)
  // مثال من Sketchware:
  //   action = update
  //   table = users
  //   data = {"name": "أحمد المحدث", "age": "26"}
  //   where = [{"column": "id", "value": "1"}]
  // ==========================================
  if (action === 'update') {
    const data = body.data;
    const where = body.where;
    if (!data || !where || Object.keys(data).length === 0 || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال "data" و "where"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { rowsAffected: 0, message: 'الجدول غير موجود - لا شيء للتحديث' } });
      return;
    }

    const setClauses = Object.keys(data).map(c => `${cleanColName(c)} = ?`);
    const values = Object.values(data);

    const conditions = [];
    where.forEach(w => {
      const col = cleanColName(w.column);
      conditions.push(`${col} = ?`);
      values.push(w.value);
    });

    const sql = `UPDATE ${cleanTable} SET ${setClauses.join(', ')} WHERE ${conditions.join(' AND ')}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 10. delete — حذف سجل
  // ==========================================
  // ماذا يفعل: يحذف سجل أو أكثر حسب الشرط
  // متى تستخدمه: عند حذف مستخدم أو منتج أو رسالة
  // مثال من Sketchware:
  //   action = delete
  //   table = users
  //   where = [{"column": "id", "value": "1"}]
  // ==========================================
  if (action === 'delete') {
    const where = body.where;
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { rowsAffected: 0, message: 'الجدول غير موجود - لا شيء للحذف' } });
      return;
    }

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = cleanColName(w.column);
      conditions.push(`${col} = ?`);
      values.push(w.value);
    });

    const sql = `DELETE FROM ${cleanTable} WHERE ${conditions.join(' AND ')}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 11. raw_query — تنفيذ استعلام SQL مخصص
  // ==========================================
  // ماذا يفعل: ينفذ أي استعلام SQL تريده
  // متى تستخدمه: للعمليات المعقدة التي لا يمكن بالكتل الجاهزة
  // تحذير: استخدم بحذر، لأنك ترسل SQL مباشرة
  // مثال من Sketchware:
  //   action = raw_query
  //   sql = SELECT name, age FROM users WHERE age > ? ORDER BY age DESC
  //   params = ["18"]
  // ==========================================
  if (action === 'raw_query') {
    const sql = body.sql;
    const params = body.params || [];
    if (!sql || typeof sql !== 'string') {
      response.status(400).json({ success: false, error: 'يجب إرسال الاستعلام في الحقل "sql"' });
      return;
    }
    const result = await executeSQL(sql, params);
    response.json(result);
    return;
  }

  // ==========================================
  // 12. batch — تنفيذ عدة استعلامات دفعة
  // ==========================================
  // ماذا يفعل: ينفذ عدة استعلامات SQL في طلب واحد
  // متى تستخدمه: حذف من جدول وإضافة لجدول آخر في نفس اللحظة
  // مثال من Sketchware:
  //   action = batch
  //   statements = [{"sql": "INSERT INTO users (name) VALUES (?)", "args": ["أحمد"]}]
  // ==========================================
  if (action === 'batch') {
    const statements = body.statements;
    if (!statements || !Array.isArray(statements) || statements.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الاستعلامات في الحقل "statements"' });
      return;
    }
    const result = await executeBatch(statements);
    response.json(result);
    return;
  }

  // ==========================================
  // 13. search — البحث بنص في الأعمدة
  // ==========================================
  // ماذا يفعل: يبحث عن نص في أعمدة محددة باستخدام LIKE
  // متى تستخدمه: في شريط البحث للبحث عن اسم أو منتج
  // مثال من Sketchware:
  //   action = search
  //   table = users
  //   query = أحمد
  //   columns = ["name"]
  // ==========================================
  if (action === 'search') {
    const query = body.query;
    const searchColumns = body.columns || [];
    if (!query) {
      response.status(400).json({ success: false, error: 'يجب إرسال نص البحث في الحقل "query"' });
      return;
    }

    let sql;
    const values = [];
    if (searchColumns.length > 0) {
      const cleanCols = searchColumns.map(c => cleanColName(c));
      const likeConditions = cleanCols.map(c => `${c} LIKE ?`).join(' OR ');
      values.push(...cleanCols.map(() => `%${query}%`));
      sql = `SELECT * FROM ${cleanTable} WHERE ${likeConditions}`;
    } else {
      sql = `SELECT * FROM ${cleanTable}`;
    }
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 14. count — عد السجلات
  // ==========================================
  // ماذا يفعل: يعرف عدد السجلات في الجدول (مع أو بدون شرط)
  // متى تستخدمه: لمعرفة عدد المستخدمين الكلي أو المنتجات المتاحة
  // مثال بدون شرط: action = count, table = users
  // مثال مع شرط: action = count, table = users, where = [{"column": "age", "value": "25"}]
  // الرد: {success: true, data: {rows: [{"total": 5}]}}
  // ==========================================
  if (action === 'count') {
    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { rows: [{"total": 0}], message: 'الجدول غير موجود' } });
      return;
    }
    const where = body.where;
    let sql = `SELECT COUNT(*) as total FROM ${cleanTable}`;
    const values = [];
    if (where && Array.isArray(where) && where.length > 0) {
      const conditions = [];
      where.forEach(w => {
        const col = cleanColName(w.column);
        conditions.push(`${col} = ?`);
        values.push(w.value);
      });
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 15. get_columns — جلب معلومات أعمدة الجدول
  // ==========================================
  // ماذا يفعل: يجلب أسماء وأنواع الأعمدة في جدول
  // متى تستخدمه: نادراً — عند بناء تطبيق ديناميكي
  // مثال من Sketchware:
  //   action = get_columns
  //   table = users
  // الرد: {rows: [{name: "id", type: "INTEGER"}, ...]}
  // ==========================================
  if (action === 'get_columns') {
    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { rows: [], message: 'الجدول غير موجود' } });
      return;
    }
    const sql = `PRAGMA table_info(${cleanTable})`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 16. get_tables — جلب أسماء جميع الجداول
  // ==========================================
  // ماذا يفعل: يجلب أسماء كل الجداول في قاعدة البيانات
  // متى تستخدمه: نادراً — للمطورين فقط
  // مثال من Sketchware:
  //   action = get_tables
  // الرد: {rows: [{name: "users"}, {name: "products"}]}
  // ==========================================
  if (action === 'get_tables') {
    const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 17. query_order — استعلام مع شروط وترتيب
  // ==========================================
  // ماذا يفعل: يجلب سجلات مع فلترة + ترتيب + حد
  // متى تستخدمه: جلب أحدث 10 مقالات، أو أرخص 5 منتجات
  // مثال من Sketchware:
  //   action = query_order
  //   table = users
  //   where = [{"column": "age", "value": "18", "operator": ">="}]
  //   orderBy = [{"column": "name", "direction": "ASC"}]
  //   limit = 20
  // ==========================================
  if (action === 'query_order') {
    const where = body.where || [];
    const orderBy = body.orderBy || [];
    const limit = body.limit;

    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { columns: [], rows: [], rowsAffected: 0, message: 'الجدول غير موجود' } });
      return;
    }

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = cleanColName(w.column);
      const op = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE'].includes(String(w.operator || '=').toUpperCase())
        ? String(w.operator || '=').toUpperCase() : '=';
      conditions.push(`${col} ${op} ?`);
      values.push(w.value);
    });

    let sql = `SELECT * FROM ${cleanTable}`;
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    if (orderBy.length > 0) {
      const orderClauses = orderBy.map(o => {
        const col = cleanColName(o.column);
        const dir = String(o.direction || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        return `${col} ${dir}`;
      });
      sql += ` ORDER BY ${orderClauses.join(', ')}`;
    }
    if (limit) {
      sql += ` LIMIT ${parseInt(limit)}`;
    }

    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 18. upsert — إضافة أو تحديث (إذا وجد)
  // ==========================================
  // ماذا يفعل: إذا السجل موجود يحدثه، إذا غير موجود يضيفه
  // متى تستخدمه: عند تحديث إعدادات المستخدم (إذا لم توجد يتم إنشاؤها)
  // يعتمد على وجود عمود فريد (id افتراضياً)
  // مثال من Sketchware:
  //   action = upsert
  //   table = users
  //   data = {"id": 1, "name": "أحمد", "age": "25"}
  //   uniqueColumn = id
  // ==========================================
  if (action === 'upsert') {
    const data = body.data;
    const uniqueColumn = body.uniqueColumn || 'id';
    if (!data || Object.keys(data).length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال البيانات في الحقل "data"' });
      return;
    }

    // إذا الجدول غير موجود، أنشئه
    const exists = await tableExists(cleanTable);
    if (!exists) {
      const colDefs = Object.keys(data).map(k => {
        const name = cleanColName(k);
        const val = data[k];
        const type = (typeof val === 'number' || /^\d+$/.test(String(val))) ? 'INTEGER' : 'TEXT';
        return `${name} ${type}`;
      });
      const createSql = `CREATE TABLE IF NOT EXISTS ${cleanTable} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs.join(', ')})`;
      await executeSQL(createSql);
    }

    const columns = Object.keys(data).map(c => cleanColName(c));
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => data[c]);
    
    const sql = `INSERT OR REPLACE INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 19. delete_where — حذف بعدة شروط
  // ==========================================
  // ماذا يفعل: يحذف سجلات حسب عدة شروط
  // متى تستخدمه: حذف كل المستخدمين غير النشطين
  // مثال من Sketchware:
  //   action = delete_where
  //   table = users
  //   where = [{"column": "age", "value": "20", "operator": "<"}]
  // ==========================================
  if (action === 'delete_where') {
    const where = body.where;
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { rowsAffected: 0, message: 'الجدول غير موجود - لا شيء للحذف' } });
      return;
    }

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = cleanColName(w.column);
      const op = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE'].includes(String(w.operator || '=').toUpperCase())
        ? String(w.operator || '=').toUpperCase() : '=';
      conditions.push(`${col} ${op} ?`);
      values.push(w.value);
    });
    const sql = `DELETE FROM ${cleanTable} WHERE ${conditions.join(' AND ')}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // ❌ إجراء غير معروف
  // ==========================================
  response.status(400).json({
    success: false,
    error: 'إجراء غير معروف. الإجراءات: ping, create_table, drop_table, get_all, get_by_id, get_where, insert, batch_insert, update, delete, raw_query, batch, search, count, get_columns, get_tables, query_order, upsert, delete_where'
  });
}

