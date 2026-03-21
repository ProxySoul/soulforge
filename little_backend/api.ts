import type { Result } from "./types.js";
import { validateUser, validateProduct, validateCartAdd, validateRegister } from "./validate.js";
import { verify } from "./auth.js";
import { getUser, createUser, updateUser, deleteUser, listProducts, getProduct, createProduct, updateProduct, deleteProduct, getOrder, getUserOrders, searchProducts, searchUsers } from "./db.js";
import { addToCart, checkout, getCart } from "./cart.js";
import { sendEmail, sendBulkEmail, sendSMS, getQueueLength, getDeadLetters, retryDeadLetters } from "./notifications.js";
import { requireAdmin } from "./auth.js";

type Handler = (body: any, token?: string) => Result<any>;

const routes: Record<string, Handler> = {
  "GET /products": () => ({ ok: true, data: listProducts() }),

  "GET /product": (body) => {
    const p = getProduct(body.id);
    if (!p) return { ok: false, error: "not found" };
    return { ok: true, data: p };
  },

  "GET /search/products": (body) => {
    if (!body.q) return { ok: false, error: "query parameter 'q' required" };
    return { ok: true, data: searchProducts(body.q, body.category) };
  },

  "GET /search/users": (_body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    if (!_body.q) return { ok: false, error: "query parameter 'q' required" };
    return { ok: true, data: searchUsers(_body.q) };
  },

  "POST /register": (body) => {
    const errs = validateRegister(body);
    if (errs.length) return { ok: false, error: errs.join(", ") };
    const ok = createUser({
      id: `usr_${Date.now()}`,
      name: body.name,
      email: body.email,
      password: body.password,
      role: "user",
    });
    if (!ok) return { ok: false, error: "already exists" };
    sendEmail(body.email, "Welcome!", `Hi ${body.name}`);
    return { ok: true, data: { registered: true } };
  },

  "POST /cart/add": (body, token) => {
    if (!token) return { ok: false, error: "auth required" };
    const session = verify(token);
    if (!session.ok) return session;

    const errs = validateCartAdd(body);
    if (errs.length) return { ok: false, error: errs.join(", ") };

    return addToCart(session.data.userId, body.productId, body.qty);
  },

  "POST /checkout": (_body, token) => {
    if (!token) return { ok: false, error: "auth required" };
    const session = verify(token);
    if (!session.ok) return session;
    const result = checkout(session.data.userId);
    if (result.ok) {
      const user = getUser(session.data.userId);
      sendEmail(user!.email, "Order confirmed", `Order ${result.data.id}`);
    }
    return result;
  },

  "GET /cart": (_body, token) => {
    if (!token) return { ok: false, error: "auth required" };
    const session = verify(token);
    if (!session.ok) return session;
    const cart = getCart(session.data.userId);
    return { ok: true, data: [...cart.entries()] };
  },

  "POST /admin/notify": (body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    if (!body.to || !body.subject || !body.body) {
      return { ok: false, error: "missing to, subject, or body" };
    }
    sendEmail(body.to, body.subject, body.body);
    return { ok: true, data: { sent: true } };
  },

  "POST /admin/notify/bulk": (body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    if (!Array.isArray(body.recipients)) {
      return { ok: false, error: "recipients must be an array" };
    }
    return sendBulkEmail(body.recipients);
  },

  "POST /admin/notify/sms": (body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    if (!body.phone || !body.message) {
      return { ok: false, error: "missing phone or message" };
    }
    return sendSMS(body.phone, body.message);
  },

  "GET /admin/notify/status": (_body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    return {
      ok: true,
      data: {
        queueLength: getQueueLength(),
        deadLetters: getDeadLetters(),
      },
    };
  },

  "POST /admin/notify/retry": (_body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    return retryDeadLetters();
  },

  "GET /user": (_body, token) => {
    const session = verify(token!);
    if (!session.ok) return session;
    const user = getUser(session.data.userId);
    if (!user) return { ok: false, error: "user not found" };
    return { ok: true, data: user };
  },

  "PUT /user": (body, token) => {
    const session = verify(token!);
    if (!session.ok) return session;
    const errors = validateUser({ ...body, role: body.role ?? "user" });
    if (errors.length) return { ok: false, error: errors.join(", ") };
    const ok = updateUser(session.data.userId, body);
    if (!ok) return { ok: false, error: "user not found" };
    return { ok: true, data: { updated: true } };
  },

  "DELETE /user": (_body, token) => {
    const session = verify(token!);
    if (!session.ok) return session;
    deleteUser(session.data.userId);
    return { ok: true, data: { deleted: true } };
  },

  "POST /admin/product": (body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    const errors = validateProduct(body);
    if (errors.length) return { ok: false, error: errors.join(", ") };
    const product = { id: `prod_${Date.now()}`, ...body };
    createProduct(product);
    return { ok: true, data: product };
  },

  "PUT /admin/product": (body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    if (!body.id) return { ok: false, error: "product id required" };
    const ok = updateProduct(body.id, body);
    if (!ok) return { ok: false, error: "product not found" };
    return { ok: true, data: { updated: true } };
  },

  "DELETE /admin/product": (body, token) => {
    const admin = requireAdmin(token!);
    if (!admin.ok) return admin;
    if (!body.id) return { ok: false, error: "product id required" };
    const ok = deleteProduct(body.id);
    if (!ok) return { ok: false, error: "product not found" };
    return { ok: true, data: { deleted: true } };
  },

  "GET /orders": (_body, token) => {
    const session = verify(token!);
    if (!session.ok) return session;
    return { ok: true, data: getUserOrders(session.data.userId) };
  },

  "GET /order": (body, token) => {
    const session = verify(token!);
    if (!session.ok) return session;
    const order = getOrder(body.id);
    if (!order) return { ok: false, error: "order not found" };
    if (order.userId !== session.data.userId) return { ok: false, error: "forbidden" };
    return { ok: true, data: order };
  },
};

export function handle(method: string, path: string, body: any, token?: string): Result<any> {
  const key = `${method} ${path}`;
  const handler = routes[key];
  if (!handler) return { ok: false, error: `no route: ${key}` };
  return handler(body, token);
}
