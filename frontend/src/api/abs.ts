import { useMutation, useQuery } from "@tanstack/react-query";
import type { AbsLibrary, AbsTestConnectionResponse } from "../types";

interface AbsSyncStatus {
  status: string;
  total_authors: number;
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
  message: string;
}

export function useAbsTestConnection() {
  return useMutation({
    mutationFn: async (params: { url?: string; api_key?: string }) => {
      const response = await fetch("/api/abs/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        throw new Error("Failed to test connection");
      }
      return response.json() as Promise<AbsTestConnectionResponse>;
    },
  });
}

export function useAbsLibraries(enabled: boolean = true) {
  return useQuery({
    queryKey: ["abs-libraries"],
    queryFn: async () => {
      const response = await fetch("/api/abs/libraries");
      if (!response.ok) {
        throw new Error("Failed to fetch libraries");
      }
      return response.json() as Promise<AbsLibrary[]>;
    },
    enabled,
    staleTime: 60000, // 1 minute
  });
}

export function useAbsSyncStatus(enabled: boolean = false) {
  return useQuery({
    queryKey: ["abs-sync-status"],
    queryFn: async () => {
      const response = await fetch("/api/abs/sync-status");
      if (!response.ok) {
        throw new Error("Failed to fetch sync status");
      }
      return response.json() as Promise<AbsSyncStatus>;
    },
    enabled,
    refetchInterval: enabled ? 1000 : false,
  });
}

export function useAbsSyncAuthorImages() {
  return useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/abs/sync-author-images", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Failed to start sync");
      }
      return response.json() as Promise<AbsSyncStatus>;
    },
  });
}

interface AbsLookupBookResponse {
  found: boolean;
  abs_url: string | null;
  abs_item_id: string | null;
  abs_title: string | null;
}

export function useAbsLookupBook() {
  return useMutation({
    mutationFn: async (filePath: string) => {
      const response = await fetch("/api/abs/lookup-book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_path: filePath }),
      });
      if (!response.ok) {
        throw new Error("Failed to lookup book");
      }
      return response.json() as Promise<AbsLookupBookResponse>;
    },
  });
}
