import type { User, Product, Order } from "./types.js";

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validateUser(u: Partial<User>): string[] {
  const errors: string[] = [];
  if (!u.name || u.name.length < 2) errors.push("name too short");
  if (!u.email || !validateEmail(u.email)) errors.push("invalid email");
  if (!u.role) errors.push("role required");
  return errors;
}

export function validatePassword(password: string): string[] {
  const errors: string[] = [];
  if (!password) errors.push("password required");
  else {
    if (password.length < 8) errors.push("password must be at least 8 characters");
    if (!/\d/.test(password)) errors.push("password must contain a number");
  }
  return errors;
}

export function validateProduct(p: Partial<Product>): string[] {
  const errors: string[] = [];
  if (!p.name) errors.push("name required");
  if (!p.description) errors.push("description required");
  if (!p.category) errors.push("category required");
  if (p.price == null || p.price < 0) errors.push("invalid price");
  if (p.stock == null || p.stock < 0) errors.push("invalid stock");
  if (p.tags && !Array.isArray(p.tags)) errors.push("tags must be an array");
  return errors;
}

export function validateOrder(o: Partial<Order>): string[] {
  const errors: string[] = [];
  if (!o.userId) errors.push("userId required");
  if (!o.items || o.items.length === 0) errors.push("no items");
  if (o.total != null && o.total < 0) errors.push("negative total");
  return errors;
}

export function validateCartAdd(body: any): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return ["body required"];
  if (typeof body.productId !== "string" || body.productId.length === 0) errors.push("productId required");
  if (typeof body.qty !== "number" || !Number.isInteger(body.qty) || body.qty <= 0) errors.push("qty must be a positive integer");
  return errors;
}

export function validateRegister(body: any): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return ["body required"];
  if (typeof body.name !== "string" || body.name.length < 2) errors.push("name too short");
  if (typeof body.email !== "string" || !validateEmail(body.email)) errors.push("invalid email");
  return errors;
}
