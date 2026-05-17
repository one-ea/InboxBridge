export class PermissionService {
  private readonly adminIds: Set<number>;

  constructor(adminUserIds: number[]) {
    this.adminIds = new Set(adminUserIds);
  }

  isAdmin(userId: number | undefined): boolean {
    return typeof userId === "number" && this.adminIds.has(userId);
  }
}
