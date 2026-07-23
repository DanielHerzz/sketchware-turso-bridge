const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// ============================================
// إعداد الاتصال بقاعدة بيانات Turso
// ============================================
const client = createClient({
  url: process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

// ============================================
// مفاتيح الأمان
// ============================================
const APP_SECRET = process.env.APP_SECRET_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'my-super-secret-jwt-key-change-this-in-production';

function verifyApiKey(headers) {
  if (!APP_SECRET) return true;
  return headers['x-api-key'] === APP_SECRET;
}

// توليد JWT Token
function generateToken(userId) {
  return jwt.sign({ userId, iat: Date.now() }, JWT_SECRET, { expiresIn: '30d' });
}

// التحقق من JWT Token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// جلب المستخدم الحالي من التوكن
async function getCurrentUser(token) {
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded) return null;
  
  const result = await client.execute({
    sql: 'SELECT id, email, name FROM users WHERE id = ?',
    args: [decoded.userId]
  });
  
  if (result.rows.length === 0) return null;
  
  const row = result.rows[0];
  return {
    id: row[0],
    email: row[1],
    name: row[2]
  };
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

function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  return String(value);
}

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

async function autoCreateTable(cleanTable, dataKeys, firstRow) {
  const colDefs = dataKeys.map(k => {
    const name = cleanColName(k);
    const val = firstRow[k];
    let type = 'TEXT';
    if (typeof val === 'number') {
      type = Number.isInteger(val) ? 'INTEGER' : 'REAL';
    } else if (typeof val === 'string' && /^\d+$/.test(val)) {
      type = 'INTEGER';
    }
    return `${name} ${type}`;
  });
  const createSql = `CREATE TABLE IF NOT EXISTS ${cleanTable} (id INTEGER PRIMARY KEY, ${colDefs.join(', ')})`;
  return await executeSQL(createSql);
}

// إنشاء جدول المستخدمين تلقائياً
async function ensureUsersTable() {
  const exists = await tableExists('users');
  if (!exists) {
    await executeSQL(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
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

  // قراءة البيانات المرسلة (JSON)
  let body = {};
  try {
    if (request.body) {
      if (typeof request.body === 'string') {
        body = JSON.parse(request.body);
      } else {
        body = request.body;
      }
    }
  } catch (e) {
    response.status(400).json({ success: false, error: 'بيانات JSON غير صالحة: ' + e.message });
    return;
  }

  const action = body.action || request.query.action || '';
  const table = body.table || request.query.table || '';

  // ==========================================
  // 🌟 نظام تسجيل الدخول (أولوية)
  // ==========================================

  // ------------------------------------------
  // 20. register — تسجيل مستخدم جديد
  // ------------------------------------------
  // ماذا يفعل: ينشئ حساب جديد في جدول users
  // يحتاج: email + password + name (اختياري)
  // 
  // مثال من Sketchware:
  //   action = register
  //   email = user@example.com
  //   password = MyPass123
  //   name = أحمد (اختياري)
  //
  // الرد: {success: true, data: {token: "...", user: {...}}}
  // ==========================================
  if (action === 'register') {
    const email = sanitizeValue(body.email);
    const password = sanitizeValue(body.password);
    const name = sanitizeValue(body.name) || null;

    if (!email || !password) {
      response.status(400).json({ success: false, error: 'يجب إرسال البريد الإلكتروني وكلمة المرور' });
      return;
    }

    // التحقق من صحة البريد الإلكتروني (بسيط)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      response.status(400).json({ success: false, error: 'صيغة البريد الإلكتروني غير صحيحة' });
      return;
    }

    // التحقق من طول كلمة المرور
    if (password.length < 6) {
      response.status(400).json({ success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
      return;
    }

    // إنشاء جدول المستخدمين إذا غير موجود
    await ensureUsersTable();

    // التحقق من عدم وجود البريد مسبقاً
    const existing = await client.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [email]
    });

    if (existing.rows.length > 0) {
      response.status(400).json({ success: false, error: 'هذا البريد الإلكتروني مسجل مسبقاً' });
      return;
    }

    // تشفير كلمة المرور
    const hashedPassword = await bcrypt.hash(password, 10);

    // توليد ID عشوائي (timestamp + random)
    const userId = Date.now();

    // إضافة المستخدم
    const result = await executeSQL(
      'INSERT INTO users (id, email, password, name) VALUES (?, ?, ?, ?)',
      [userId, email, hashedPassword, name]
    );

    if (!result.success) {
      response.json({ success: false, error: result.error });
      return;
    }

    // توليد توكن
    const token = generateToken(userId);

    response.json({
      success: true,
      message: 'تم التسجيل بنجاح',
      data: {
        token: token,
        user: {
          id: userId,
          email: email,
          name: name
        }
      }
    });
    return;
  }

  // ------------------------------------------
  // 21. login — تسجيل الدخول
  // ------------------------------------------
  // ماذا يفعل: يتحقق من البيانات ويعيد توكن
  // يحتاج: email + password
  //
  // مثال من Sketchware:
  //   action = login
  //   email = user@example.com
  //   password = MyPass123
  //
  // الرد: {success: true, data: {token: "...", user: {...}}}
  // ==========================================
  if (action === 'login') {
    const email = sanitizeValue(body.email);
    const password = sanitizeValue(body.password);

    if (!email || !password) {
      response.status(400).json({ success: false, error: 'يجب إرسال البريد الإلكتروني وكلمة المرور' });
      return;
    }

    // إنشاء جدول المستخدمين إذا غير موجود
    await ensureUsersTable();

    // جلب المستخدم
    const result = await client.execute({
      sql: 'SELECT id, email, password, name FROM users WHERE email = ?',
      args: [email]
    });

    if (result.rows.length === 0) {
      response.status(401).json({ success: false, error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
      return;
    }

    const row = result.rows[0];
    const storedPassword = row[2];
    const user = {
      id: row[0],
      email: row[1],
      name: row[3]
    };

    // التحقق من كلمة المرور
    const isValid = await bcrypt.compare(password, storedPassword);
    if (!isValid) {
      response.status(401).json({ success: false, error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' });
      return;
    }

    // توليد توكن
    const token = generateToken(user.id);

    response.json({
      success: true,
      message: 'تم تسجيل الدخول بنجاح',
      data: {
        token: token,
        user: user
      }
    });
    return;
  }

  // ------------------------------------------
  // 22. me — جلب بيانات المستخدم الحالي
  // ------------------------------------------
  // ماذا يفعل: يجلب بيانات المستخدم من التوكن
  // يحتاج: Header "Authorization" = "Bearer TOKEN"
  //
  // مثال: أرسل هذا في Header التوكن المستلم عند التسجيل/الدخول
  // ==========================================
  if (action === 'me') {
    const authHeader = request.headers.authorization || request.headers.Authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    
    if (!token) {
      response.status(401).json({ success: false, error: 'يجب إرسال التوكن في Header Authorization' });
      return;
    }

    const user = await getCurrentUser(token);
    if (!user) {
      response.status(401).json({ success: false, error: 'التوكن غير صالح أو منتهي الصلاحية' });
      return;
    }

    response.json({
      success: true,
      data: { user: user }
    });
    return;
  }

  // ------------------------------------------
  // 23. change_password — تغيير كلمة المرور
  // ------------------------------------------
  // يحتاج: Authorization + old_password + new_password
  // ==========================================
  if (action === 'change_password') {
    const authHeader = request.headers.authorization || request.headers.Authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    
    const oldPassword = sanitizeValue(body.old_password);
    const newPassword = sanitizeValue(body.new_password);

    if (!token || !oldPassword || !newPassword) {
      response.status(400).json({ success: false, error: 'يجب إرسال التوكن وكلمة المرور القديمة والجديدة' });
      return;
    }

    if (newPassword.length < 6) {
      response.status(400).json({ success: false, error: 'كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل' });
      return;
    }

    const user = await getCurrentUser(token);
    if (!user) {
      response.status(401).json({ success: false, error: 'التوكن غير صالح' });
      return;
    }

    // جلب كلمة المرور المشفرة
    const result = await client.execute({
      sql: 'SELECT password FROM users WHERE id = ?',
      args: [user.id]
    });

    const isValid = await bcrypt.compare(oldPassword, result.rows[0][0]);
    if (!isValid) {
      response.status(400).json({ success: false, error: 'كلمة المرور القديمة غير صحيحة' });
      return;
    }

    const hashedNew = await bcrypt.hash(newPassword, 10);
    await executeSQL('UPDATE users SET password = ? WHERE id = ?', [hashedNew, user.id]);

    response.json({
      success: true,
      message: 'تم تغيير كلمة المرور بنجاح'
    });
    return;
  }

  // ------------------------------------------
  // 24. reset_password — إعادة تعيين كلمة المرور
  // ------------------------------------------
  // يحتاج: email + token + new_password
  // ملاحظة: هذه نسخة مبسطة — في الإنتاج يفضل إرسال رابط عبر البريد
  // ==========================================
  if (action === 'reset_password') {
    const email = sanitizeValue(body.email);
    const resetToken = sanitizeValue(body.token);
    const newPassword = sanitizeValue(body.new_password);

    if (!email || !resetToken || !newPassword) {
      response.status(400).json({ success: false, error: 'يجب إرسال البريد والتوكن وكلمة المرور الجديدة' });
      return;
    }

    await ensureUsersTable();

    // التحقق من التوكن (في هذه النسخة المبسطة، التوكن = توكن JWT صحيح للمستخدم)
    const decoded = verifyToken(resetToken);
    if (!decoded) {
      response.status(400).json({ success: false, error: 'توكن إعادة التعيين غير صالح' });
      return;
    }

    const hashedNew = await bcrypt.hash(newPassword, 10);
    const result = await executeSQL(
      'UPDATE users SET password = ? WHERE email = ?',
      [hashedNew, email]
    );

    response.json({
      success: result.success,
      message: result.success ? 'تم إعادة تعيين كلمة المرور' : result.error
    });
    return;
  }

  // ==========================================
  // 1. ping — اختبار الاتصال بالخادم
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
  if (!table && action !== 'ping' && action !== 'get_tables' && action !== 'raw_query' && action !== 'batch'
      && action !== 'register' && action !== 'login' && action !== 'me' && action !== 'change_password' && action !== 'reset_password') {
    response.status(400).json({
      success: false,
      error: 'يجب إرسال اسم الجدول في الحقل "table"'
    });
    return;
  }

  let cleanTable = '';
  if (table) {
    cleanTable = cleanTableName(table);
    if (!cleanTable) {
      response.status(400).json({ success: false, error: 'اسم الجدول غير صالح' });
      return;
    }
  }

  // ==========================================
  // 2. create_table — إنشاء جدول جديد
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
      colDefs.unshift('id INTEGER PRIMARY KEY');
    }

    const createSql = `CREATE TABLE IF NOT EXISTS ${cleanTable} (${colDefs.join(', ')})`;
    await executeSQL(createSql);

    try {
      const existingCols = await client.execute({ sql: `PRAGMA table_info(${cleanTable})` });
      const existingNames = existingCols.rows.map(r => r[1]);

      for (const col of columns) {
        const colName = cleanColName(col.name);
        if (!existingNames.includes(colName)) {
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
  if (action === 'drop_table') {
    const sql = `DROP TABLE IF EXISTS ${cleanTable}`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 4. get_all — جلب جميع السجلات
  // ==========================================
  if (action === 'get_all') {
    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { columns: [], rows: [], rowsAffected: 0, message: 'الجدول غير موجود' } });
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
      values.push(sanitizeValue(w.value));
    });

    const limit = body.limit ? ` LIMIT ${parseInt(body.limit)}` : '';
    const sql = `SELECT * FROM ${cleanTable} WHERE ${conditions.join(' AND ')}${limit}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 7. insert — إضافة سجل جديد
  // ==========================================
  if (action === 'insert') {
    const reservedKeys = ['action', 'table', 'data', 'where', 'columns', 'query', 
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

    const exists = await tableExists(cleanTable);
    if (!exists) {
      await autoCreateTable(cleanTable, Object.keys(data), data);
    }

    const columns = Object.keys(data).map(c => cleanColName(c));
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => sanitizeValue(data[c]));
    const sql = `INSERT INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 8. batch_insert — إضافة عدة سجلات دفعة واحدة
  // ==========================================
  if (action === 'batch_insert') {
    const dataArray = body.data;
    if (!dataArray || !Array.isArray(dataArray) || dataArray.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة البيانات في الحقل "data"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      await autoCreateTable(cleanTable, Object.keys(dataArray[0]), dataArray[0]);
    }

    const columns = Object.keys(dataArray[0]).map(c => cleanColName(c));
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    
    try {
      const results = [];
      for (const item of dataArray) {
        const values = columns.map(c => sanitizeValue(item[c]));
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
  if (action === 'update') {
    const data = body.data;
    const where = body.where;
    if (!data || !where || Object.keys(data).length === 0 || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال "data" و "where"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { rowsAffected: 0, message: 'الجدول غير موجود' } });
      return;
    }

    const setClauses = Object.keys(data).map(c => `${cleanColName(c)} = ?`);
    const values = Object.values(data).map(v => sanitizeValue(v));

    const conditions = [];
    where.forEach(w => {
      const col = cleanColName(w.column);
      conditions.push(`${col} = ?`);
      values.push(sanitizeValue(w.value));
    });

    const sql = `UPDATE ${cleanTable} SET ${setClauses.join(', ')} WHERE ${conditions.join(' AND ')}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 10. delete — حذف سجل
  // ==========================================
  if (action === 'delete') {
    const where = body.where;
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { rowsAffected: 0, message: 'الجدول غير موجود' } });
      return;
    }

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = cleanColName(w.column);
      conditions.push(`${col} = ?`);
      values.push(sanitizeValue(w.value));
    });

    const sql = `DELETE FROM ${cleanTable} WHERE ${conditions.join(' AND ')}`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 11. raw_query — تنفيذ استعلام SQL مخصص
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
        values.push(sanitizeValue(w.value));
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
  if (action === 'get_tables') {
    const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
    const result = await executeSQL(sql);
    response.json(result);
    return;
  }

  // ==========================================
  // 17. query_order — استعلام مع شروط وترتيب
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
      values.push(sanitizeValue(w.value));
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
  if (action === 'upsert') {
    const data = body.data;
    const uniqueColumn = body.uniqueColumn || 'id';
    if (!data || Object.keys(data).length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال البيانات في الحقل "data"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      await autoCreateTable(cleanTable, Object.keys(data), data);
    }

    const columns = Object.keys(data).map(c => cleanColName(c));
    const placeholders = columns.map(() => '?').join(', ');
    const values = columns.map(c => sanitizeValue(data[c]));
    
    const sql = `INSERT OR REPLACE INTO ${cleanTable} (${columns.join(', ')}) VALUES (${placeholders})`;
    const result = await executeSQL(sql, values);
    response.json(result);
    return;
  }

  // ==========================================
  // 19. delete_where — حذف بعدة شروط
  // ==========================================
  if (action === 'delete_where') {
    const where = body.where;
    if (!where || !Array.isArray(where) || where.length === 0) {
      response.status(400).json({ success: false, error: 'يجب إرسال مصفوفة الشروط "where"' });
      return;
    }

    const exists = await tableExists(cleanTable);
    if (!exists) {
      response.json({ success: true, data: { rowsAffected: 0, message: 'الجدول غير موجود' } });
      return;
    }

    const conditions = [];
    const values = [];
    where.forEach(w => {
      const col = cleanColName(w.column);
      const op = ['=', '!=', '>', '<', '>=', '<=', 'LIKE', 'NOT LIKE'].includes(String(w.operator || '=').toUpperCase())
        ? String(w.operator || '=').toUpperCase() : '=';
      conditions.push(`${col} ${op} ?`);
      values.push(sanitizeValue(w.value));
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
    error: 'إجراء غير معروف. الإجراءات: ping, register, login, me, change_password, reset_password, create_table, drop_table, get_all, get_by_id, get_where, insert, batch_insert, update, delete, raw_query, batch, search, count, get_columns, get_tables, query_order, upsert, delete_where'
  });
  }
