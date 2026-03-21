export interface User {
  id: string;
  name: string;
  email: string;
  password: string;
  role: "admin" | "user";
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  price: number;
  stock: number;
  imageUrl?: string;
  createdAt: number;
}

export interface Order {
  id: string;
  userId: string;
  items: { productId: string; qty: number }[];
  total: number;
  status: "pending" | "paid" | "shipped";
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
