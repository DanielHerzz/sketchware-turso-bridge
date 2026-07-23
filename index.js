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
// يمكن تعيين مفتاح API اختياري لحماية الخادم
// إذا تم تعيين APP_SECRET_KEY في Vercel Environment Variables
// فكل طلب يجب أن يحتوي على header: x-api-key
// ============================================

const APP_SECRET = process.env.APP_SECRET_KEY || '';

function verifyApiKey(headers) {
  if (!APP_SECRET) return true; // لا يوجد مفتاح = مفتوح للجميع
  return headers['x-api-key'] === APP_SECRET;
}

// ============================================
// دالة مساعدة لتنفيذ SQL بأمان
// ============================================
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

// ============================================
// دالة لتنفيذ عدة استعلامات (Batch)
// ============================================
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

// ============================================
// Vercel Serverless Function Handler
// ============================================
module.exports = async function handler(request, response) {
  
  // ==========================================
  // إعداد CORS (السماح بالطلبات من أي مصدر)
  // ==========================================
  response.setHeader('Access-Control-Allow-Credentials', true);
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  
  if (request.method === 'OPTIONS') {
    response.status(200).end();
    return;
  }

  // ==========================================
  // التحقق من مفتاح الأمان
  // ==========================================
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
  // نقطة اختبار الاتصال
  // ==========================================
  if (action === 'ping' || request.url === '/api?ping') {
    response.json({
      success: true,
      message: 'الخادم يعمل بنجاح ✅',
      database: 'Turso (libSQL)',
      timestamp: new Date().toISOString()
    });
    return;
  }

  // ==========================================
  // التحقق من وجود اسم الجدول
  // ==========================================
  if (!table && action !== 'ping') {
    response.status(400).json({
      success: false,
      error: 'يجب إرسال اسم الجدول في الحقل "table"'
    });
    return;
  }

  // حماية: تنظيف اسم الجدول (تجنب SQL Injection في اسم الجدول)
  const cleanTable = String(table).replace(/[^a-zA-Z0-9_]/g, '');
  if (!cleanTable) {
    response.status(400).json({ success: false, error: 'اسم الجدول غير صالح' });
    return;
  }

  // ==========================================
  // 1️⃣ إنشاء جدول جديد
  // ==========================================
  if (action === 'create_table') {
    const columns = body.columns; // [{name: 'email', type: 'TEXT'}, {name: 'age', type: 'INTEGER'}]
    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الأعمدة "columns"' });
      return;
    }

    const colDefs = columns.map(col => {
      const name = String(col.name).replace(/[^a-zA-Z0-9_]/g, '');
      const type = String(col.type || 'TEXT').toUpperCase();
      const isPrimary = col.primaryKey ? ' PRIMARY KEY' : '';
      const isAutoIncrement = col.autoIncrement ? ' AUTOINCREMENT' : '';
      const isNotNull = col.notNull ? ' NOT NULL' : '';
      const isUnique = col.unique ? ' UNIQUE' : '';
      const isDefault = col.default !== undefined ? ` DEFAULT ${typeof col.default === 'string' ? `'${col.default}'` : col.default}` : '';
      return `${name} ${type}${isPrimary}${isAutoIncrement}${isNotNull}${isUnique}${isDefault}`;
    });

    // إضافة مفتاح رئيسي تلقائي إذا لم يتم تحديده
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
  // 2️⃣ حذف جدول
  // ==========================================
  if (action === 'drop_table') {
    const sql = `DROP TABLE IF EXISTS ${cleanTable}`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 3️⃣ جلب جميع السجلات
  // ==========================================
  if (action === 'get_all' || action === 'read_all') {
    const sql = `SELECT * FROM ${cleanTable}`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 4️⃣ جلب سجل واحد بالـ ID
  // ==========================================
  if (action === 'get_by_id' || action === 'read_by_id') {
    const id = body.id;
    const sql = `SELECT * FROM ${cleanTable} WHERE id = ?`;
    const result = await executeSQL(sql, [id]);
    response.json(result);
    return;
  }

  // ==========================================
  // 5️⃣ جلب سجلات بشرط (WHERE)
  // ==========================================
  if (action === 'get_where' || action === 'read_where') {
    const where = body.where; // [{column: 'status', value: 'active', operator: '='}]
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
      return;
    }

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = String(w.column).replace(/[^a-zA-Z0-9_]/g, '');
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
  // 6️⃣ إضافة سجل جديد (INSERT)
  // ==========================================
  if (action === 'insert' || action === 'add') {
    const data = body.data; // {name: 'أحمد', email: 'ahmed@test.com', age: 25}
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال بيانات السجل في الحقل "data"' });
      return;
    }

    const columns = Object.keys(data).map(c => String(c).replace(/[^a-zA-Z0-9_]/g, ''));
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => data[c]);
    const sql = `INSERT INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 7️⃣ إضافة عدة سجلات دفعة واحدة (BATCH INSERT)
  // ==========================================
  if (action === 'batch_insert' || action === 'add_all') {
    const dataArray = body.data; // [{name: 'أحمد'}, {name: 'محمد'}, ...]
    if (!dataArray || !Array.isArray(dataArray) || dataArray.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة البيانات في الحقل "data"' });
      return;
    }

    // جلب الأعمدة من أول عنصر
    const columns = Object.keys(dataArray[0]).map(c => String(c).replace(/[^a-zA-Z0-9_]/g, ''));
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    
    // استخدام Transaction لتنفيذ كل الإدخالات معاً
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
  // 8️⃣ تحديث سجل (UPDATE)
  // ==========================================
  if (action === 'update') {
    const data = body.data; // {name: 'أحمد المحدّث'}
    const where = body.where; // [{column: 'id', value: 1}]
    if (!data || !where || Object.keys(data).length === 0 || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال "data" و "where"' });
      return;
    }

    const setClauses = Object.keys(data).map(c => {
      const col = String(c).replace(/[^a-zA-Z0-9_]/g, '');
      return `${col} = ?`;
    });
    const values = Object.values(data);

    const conditions = [];
    where.forEach(w => {
      const col = String(w.column).replace(/[^a-zA-Z0-9_]/g, '');
      conditions.push(`${col} = ?`);
      values.push(w.value);
    });

    const sql = `UPDATE ${cleanTable} SET ${setClauses.join(', ')} WHERE ${conditions.join(' AND ')}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 9️⃣ حذف سجل (DELETE)
  // ==========================================
  if (action === 'delete') {
    const where = body.where; // [{column: 'id', value: 1}]
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
      return;
    }

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = String(w.column).replace(/[^a-zA-Z0-9_]/g, '');
      conditions.push(`${col} = ?`);
      values.push(w.value);
    });

    const sql = `DELETE FROM ${cleanTable} WHERE ${conditions.join(' AND ')}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 🔟 تنفيذ استعلام SQL مخصص
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
  // 1️⃣1️⃣ تنفيذ عدة استعلامات (Batch)
  // ==========================================
  if (action === 'batch') {
    const statements = body.statements; // [{sql: '...', args: [...]}, ...]
    if (!statements || !Array.isArray(statements) || statements.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الاستعلامات في الحقل "statements"' });
      return;
    }
    const result = await executeBatch(statements);
    response.json(result);
    return;
  }

  // ==========================================
  // 1️⃣2️⃣ البحث (LIKE)
  // ==========================================
  if (action === 'search') {
    const query = body.query; // النص المراد البحث عنه
    const columns = body.columns || []; // الأعمدة المراد البحث فيها
    if (!query) {
      response.status(400).json({ success: false, error: 'يجب إرسال نص البحث في الحقل "query"' });
      return;
    }

    let sql;
    const values = [];
    if (columns.length > 0) {
      const cleanCols = columns.map(c => String(c).replace(/[^a-zA-Z0-9_]/g, ''));
      const likeConditions = cleanCols.map(c => `${c} LIKE ?`).join(' OR ');
      values.push(...cleanCols.map(() => `%${query}%`));
      sql = `SELECT * FROM ${cleanTable} WHERE ${likeConditions}`;
    } else {
      sql = `SELECT * FROM ${cleanTable} WHERE 1=1`; // بدون أعمدة محددة، يعيد كل شيء
    }
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 1️⃣3️⃣ عد السجلات
  // ==========================================
  if (action === 'count') {
    const where = body.where;
    let sql = `SELECT COUNT(*) as total FROM ${cleanTable}`;
    const values = [];
    if (where && Array.isArray(where) && where.length > 0) {
      const conditions = [];
      where.forEach(w => {
        const col = String(w.column).replace(/[^a-zA-Z0-9_]/g, '');
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
  // 1️⃣4️⃣ جلب أعمدة الجدول
  // ==========================================
  if (action === 'get_columns') {
    const sql = `PRAGMA table_info(${cleanTable})`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 1️⃣5️⃣ جلب جميع الجداول
  // ==========================================
  if (action === 'get_tables') {
    const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 1️⃣6️⃣ حذف شرط (DELETE WHERE)
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
      const col = String(w.column).replace(/[^a-zA-Z0-9_]/g, '');
      conditions.push(`${col} = ?`);
      values.push(w.value);
    });
    const sql = `DELETE FROM ${cleanTable} WHERE ${conditions.join(' AND ')}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 1️⃣7️⃣ استعلام مخصص مع ترتيب
  // ==========================================
  if (action === 'query_order') {
    const where = body.where || [];
    const orderBy = body.orderBy || [];
    const limit = body.limit;

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = String(w.column).replace(/[^a-zA-Z0-9_]/g, '');
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
        const col = String(o.column).replace(/[^a-zA-Z0-9_]/g, '');
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
  // 1️⃣8️⃣ تحديث أو إضافة (UPSERT)
  // ==========================================
  if (action === 'upsert') {
    const data = body.data;
    const uniqueColumn = body.uniqueColumn || 'id';
    if (!data || Object.keys(data).length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال البيانات في الحقل "data"' });
      return;
    }

    const columns = Object.keys(data).map(c => String(c).replace(/[^a-zA-Z0-9_]/g, ''));
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => data[c]);
    
    // استخدام INSERT OR REPLACE
    const uniqueCol = String(uniqueColumn).replace(/[^a-zA-Z0-9_]/g, '');
    const sql = `INSERT OR REPLACE INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // ❌ إجراء غير معروف
  // ==========================================
  response.status(400).json({
    success: false,
    error: 'إجراء غير معروف. الإجراءات المتاحة: ping, create_table, drop_table, get_all, get_by_id, get_where, insert, batch_insert, update, delete, raw_query, batch, search, count, get_columns, get_tables, delete_where, query_order, upsert'
  });
}
