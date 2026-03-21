import type { User, Product, Order } from "./types.js";

const users = new Map<string, User>();
const products = new Map<string, Product>();
const orders = new Map<string, Order>();

export function getUser(id: string): User | undefined {
  return users.get(id);
}

export function createUser(user: User) {
  if (users.has(user.id)) return false;
  users.set(user.id, user);
  return true;
}

export function updateUser(id: string, data: Partial<User>): boolean {
  const user = users.get(id);
  if (!user) return false;
  const { id: _id, ...fields } = data;
  users.set(id, { ...user, ...fields });
  return true;
}

export function deleteUser(id: string): boolean {
  return users.delete(id);
}

export function getUserByEmail(email: string): User | undefined {
  for (const user of users.values()) {
    if (user.email === email) return user;
  }
  return undefined;
}

export function getProduct(id: string) {
  return products.get(id);
}

export function createProduct(p: Product) {
  products.set(p.id, p);
}

export function updateProduct(id: string, data: Partial<Product>): boolean {
  const product = products.get(id);
  if (!product) return false;
  const { id: _id, ...fields } = data;
  products.set(id, { ...product, ...fields });
  return true;
}

export function deleteProduct(id: string): boolean {
  return products.delete(id);
}

export function updateStock(productId: string, delta: number): boolean {
  const p = products.get(productId);
  if (!p) return false;
  if (p.stock + delta < 0) return false;
  p.stock += delta;
  return true;
}

export function createOrder(order: Order) {
  orders.set(order.id, order);
}

export function deleteOrder(id: string): boolean {
  return orders.delete(id);
}

export function getOrder(id: string) {
  return orders.get(id);
}

export function getUserOrders(userId: string): Order[] {
  return [...orders.values()].filter((o) => o.userId === userId);
}

export function listProducts(): Product[] {
  return [...products.values()];
}

export function searchProducts(query: string, category?: string): Product[] {
  const q = query.toLowerCase();
  return [...products.values()].filter((p) => {
    if (category && p.category.toLowerCase() !== category.toLowerCase()) return false;
    return (
      p.name.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q) ||
      p.category.toLowerCase().includes(q) ||
      p.tags.some((t) => t.toLowerCase().includes(q))
    );
  });
}

export function searchUsers(query: string): User[] {
  const q = query.toLowerCase();
  return [...users.values()].filter(
    (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)
  );
}
