/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    typedRoutes: false,
  },
  env: {
    NEXT_PUBLIC_SENTINEL_API_BASE: process.env.NEXT_PUBLIC_SENTINEL_API_BASE ?? "http://127.0.0.1:8000",
  },
};

export default nextConfig;
