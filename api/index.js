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
  if (!APP_SECRET) return true; // لا يوجد مفتاح = مفتوح للجميع
  return headers['x-api-key'] === APP_SECRET;
}

// ============================================
// دوال مساعدة
// ============================================

// تنظيف اسم العمود (حماية ضد SQL Injection)
function cleanColName(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, '');
}

// تنظيف اسم الجدول
function cleanTableName(name) {
  return String(name).replace(/[^a-zA-Z0-9_]/g, '');
}

// تنفيذ SQL
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

// تنفيذ عدة استعلامات
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

// تحديد عمود الـ ID (يدعم id أو _id أو أي اسم مخصص)
function findIdColumn(columns) {
  if (columns.some(c => c.name === 'id')) return 'id';
  if (columns.some(c => c.name === '_id')) return '_id';
  // ابحث عن أي عمود يحتوي على "id"
  const idCol = columns.find(c => c.name.toLowerCase().includes('id'));
  return idCol ? idCol.name : 'id';
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

  // قراءة البيانات المرسلة (JSON)
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
  // الاستخدام: للتأكد أن الخادم يعمل ومتصل بقاعدة البيانات
  // لا يحتاج أي بيانات إضافية
  // مثال: {"action": "ping"}
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

  // التحقق من وجود اسم الجدول (جميع العمليات الأخرى تحتاجه)
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
  // الاستخدام: عند تشغيل التطبيق لأول مرة لإنشاء الجداول المطلوبة
  // أو لإنشاء جدول جديد ديناميكيًا
  // الحقول المطلوبة: table + columns
  // columns: مصفوفة كائنات [{name: 'عمود', type: 'TEXT/INTEGER/REAL'}, ...]
  // خصائص إضافية لكل عمود: primaryKey, autoIncrement, notNull, unique, default
  // مثال:
  // {
  //   "action": "create_table",
  //   "table": "users",
  //   "columns": [
  //     {"name": "name", "type": "TEXT", "notNull": true},
  //     {"name": "age", "type": "INTEGER"}
  //   ]
  // }
  // ==========================================
  if (action === 'create_table') {
    const columns = body.columns;
    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الأعمدة "columns"' });
      return;
    }

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

    const sql = `CREATE TABLE IF NOT EXISTS ${cleanTable} (${colDefs.join(', ')})`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 3. drop_table — حذف جدول بالكامل
  // ==========================================
  // الاستخدام: حذف جدول وكل بياناته نهائياً (حذر!)
  // لا يمكن التراجع بعد الحذف
  // مثال: {"action": "drop_table", "table": "old_users"}
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
  // الاستخدام: جلب كل البيانات الموجودة في الجدول
  // مثال: {"action": "get_all", "table": "users"}
  // الرد: {success: true, data: {columns: [...], rows: [{...}, {...}]}}
  // ==========================================
  if (action === 'get_all') {
    const sql = `SELECT * FROM ${cleanTable}`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 5. get_by_id — جلب سجل واحد بالـ ID
  // ==========================================
  // الاستخدام: جلب سجل واحد فقط باستخدام رقمه (id)
  // يحتاج: حقل "id"
  // مثال: {"action": "get_by_id", "table": "users", "id": 5}
  // ==========================================
  if (action === 'get_by_id') {
    const id = body.id;
    if (id === undefined || id === null) {
      response.status(400).json({ success: false, error: 'يجب إرسال قيمة "id"' });
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
  // الاستخدام: جلب سجلات محددة بشرط واحد أو أكثر
  // يحتاج: مصفوفة "where" تحتوي على الشروط
  // يدعم: =, !=, >, <, >=, <=, LIKE, NOT LIKE
  // يدعم: LIMIT لتحديد عدد النتائج
  // مثال:
  // {
  //   "action": "get_where",
  //   "table": "users",
  //   "where": [{"column": "age", "value": "25", "operator": ">="}],
  //   "limit": 10
  // }
  // ==========================================
  if (action === 'get_where') {
    const where = body.where;
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
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
  // 7. insert — إضافة سجل واحد (الطريقة المباشرة)
  // ==========================================
  // الاستخدام: إضافة سجل جديد إلى الجدول
  // 
  // ** الطريقة الأولى (مباشرة - الأسهل): **
  // ضع action و table مباشرة في الـ Map مع بقية البيانات
  // كل الحقول الأخرى سيتم إضافتها تلقائياً كسجل
  //
  // مثال من Sketchware (ما تفعله أنت):
  //   map: action = insert
  //   map: table = users
  //   map: name = أحمد       ← هذا يضاف كحقل في السجل
  //   map: email = a@b.com  ← هذا يضاف كحقل في السجل
  //   map: uid = 12345      ← هذا يضاف كحقل في السجل
  //
  // ** الطريقة الثانية (مغلفة): **
  // {
  //   "action": "insert",
  //   "table": "users",
  //   "data": {"name": "أحمد", "email": "a@b.com"}
  // }
  //
  // كلا الطريقتين تعملان! لكن الأولى أسهل مع Sketchware
  // ==========================================
  if (action === 'insert') {
    // الطريقة المباشرة: نأخذ كل المفاتيح من body ما عدا action و table
    const reservedKeys = ['action', 'table', 'data', 'where', 'columns', 'id', 'query', 
                          'limit', 'orderBy', 'uniqueColumn', 'sql', 'params', 'statements'];
    const dataKeys = Object.keys(body).filter(k => !reservedKeys.includes(k));
    
    let data;
    if (body.data && typeof body.data === 'object' && Object.keys(body.data).length > 0) {
      // الطريقة الثانية: البيانات في حقل data
      data = body.data;
    } else if (dataKeys.length > 0) {
      // الطريقة الأولى: البيانات مباشرة في الـ Map
      data = {};
      dataKeys.forEach(k => { data[k] = body[k]; });
    } else {
      response.status(400).json({ success: false, error: 'يجب إرسال بيانات السجل' });
      return;
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
  // الاستخدام: إضافة عدة سجلات في طلب واحد (أسرع وأوفر)
  // البيانات: مصفوفة من الكائنات في حقل "data"
  // مثال:
  // {
  //   "action": "batch_insert",
  //   "table": "users",
  //   "data": [
  //     {"name": "أحمد", "age": "25"},
  //     {"name": "محمد", "age": "30"}
  //   ]
  // }
  // ==========================================
  if (action === 'batch_insert') {
    const dataArray = body.data;
    if (!dataArray || !Array.isArray(dataArray) || dataArray.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة البيانات في الحقل "data"' });
      return;
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
  // الاستخدام: تعديل بيانات سجل موجود
  // يحتاج: حقل "data" بالبيانات الجديدة + حقل "where" لتحديد السجل
  // مثال:
  // {
  //   "action": "update",
  //   "table": "users",
  //   "data": {"name": "أحمد المحدث", "age": "26"},
  //   "where": [{"column": "id", "value": "1"}]
  // }
  // ==========================================
  if (action === 'update') {
    const data = body.data;
    const where = body.where;
    if (!data || !where || Object.keys(data).length === 0 || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال "data" و "where"' });
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
  // الاستخدام: حذف سجل أو أكثر حسب الشرط
  // يحتاج: مصفوفة "where" لتحديد السجل المراد حذفه
  // مثال: {"action": "delete", "table": "users", "where": [{"column": "id", "value": "1"}]}
  // ==========================================
  if (action === 'delete') {
    const where = body.where;
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
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
  // الاستخدام: تنفيذ أي استعلام SQL تريد (SELECT, UPDATE, DELETE, ...)
  // يحتاج: حقل "sql" بالاستعلام + حقل "params" (اختياري) بالقيم
  // ⚠️ تحذير: استخدم بحذر، لأنك ترسل SQL مباشرة
  // مثال:
  // {
  //   "action": "raw_query",
  //   "sql": "SELECT name, age FROM users WHERE age > ? ORDER BY age DESC",
  //   "params": [18]
  // }
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
  // الاستخدام: تنفيذ عدة استعلامات SQL في طلب واحد
  // يحتاج: مصفوفة "statements" تحتوي على الاستعلامات
  // مثال:
  // {
  //   "action": "batch",
  //   "statements": [
  //     {"sql": "INSERT INTO users (name) VALUES (?)", "args": ["أحمد"]},
  //     {"sql": "INSERT INTO users (name) VALUES (?)", "args": ["محمد"]}
  //   ]
  // }
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
  // الاستخدام: البحث عن نص في أعمدة محددة باستخدام LIKE
  // يحتاج: حقل "query" بنص البحث + حقل "columns" (اختياري)
  // مثال: {"action": "search", "table": "users", "query": "أحمد", "columns": ["name"]}
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
  // الاستخدام: معرفة عدد السجلات في الجدول (مع أو بدون شرط)
  // مثال بدون شرط: {"action": "count", "table": "users"}
  // مثال مع شرط: {"action": "count", "table": "users", "where": [{"column": "age", "value": "25"}]}
  // الرد: {success: true, data: {rows: [{"total": 5}]}}
  // ==========================================
  if (action === 'count') {
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
  // الاستخدام: معرفة أسماء الأعمدة وأنواعها في جدول معين
  // مثال: {"action": "get_columns", "table": "users"}
  // الرد: {success: true, data: {rows: [{name: "id", type: "INTEGER", ...}, ...]}}
  // ==========================================
  if (action === 'get_columns') {
    const sql = `PRAGMA table_info(${cleanTable})`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 16. get_tables — جلب أسماء جميع الجداول
  // ==========================================
  // الاستخدام: معرفة ما هي الجداول الموجودة في قاعدة البيانات
  // لا يحتاج اسم جدول
  // مثال: {"action": "get_tables"}
  // الرد: {success: true, data: {rows: [{name: "users"}, {name: "products"}]}}
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
  // الاستخدام: جلب سجلات مع فلترة + ترتيب + حد
  // يدعم: WHERE + ORDER BY + LIMIT
  // مثال:
  // {
  //   "action": "query_order",
  //   "table": "users",
  //   "where": [{"column": "age", "value": "18", "operator": ">="}],
  //   "orderBy": [{"column": "name", "direction": "ASC"}],
  //   "limit": 20
  // }
  // ==========================================
  if (action === 'query_order') {
    const where = body.where || [];
    const orderBy = body.orderBy || [];
    const limit = body.limit;

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
  // الاستخدام: إذا السجل موجود يتم تحديثه، إذا غير موجود يتم إضافته
  // يعتمد على وجود عمود فريد (id افتراضياً)
  // مثال:
  // {
  //   "action": "upsert",
  //   "table": "users",
  //   "data": {"id": 1, "name": "أحمد", "age": "25"},
  //   "uniqueColumn": "id"
  // }
  // ==========================================
  if (action === 'upsert') {
    const data = body.data;
    const uniqueColumn = body.uniqueColumn || 'id';
    if (!data || Object.keys(data).length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال البيانات في الحقل "data"' });
      return;
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
  // الاستخدام: حذف سجلات حسب عدة شروط
  // مثال: {"action": "delete_where", "table": "users", "where": [{"column": "age", "value": "20", "operator": "<"}]}
  // ==========================================
  if (action === 'delete_where') {
    const where = body.where;
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
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
