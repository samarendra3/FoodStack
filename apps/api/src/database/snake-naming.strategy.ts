import { DefaultNamingStrategy, type NamingStrategyInterface } from 'typeorm';

/** `tenantId` → `tenant_id`, `HTTPStatus` → `http_status`, `addressLine1` → `address_line1`. */
export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
}

/**
 * snake_case database identifiers (docs/database-design.md §1). Explicit names passed to
 * decorators always win. Table names are not pluralized automatically: name every entity
 * explicitly, e.g. `@Entity('orders')`.
 */
export class SnakeNamingStrategy extends DefaultNamingStrategy implements NamingStrategyInterface {
  override tableName(targetName: string, userSpecifiedName: string | undefined): string {
    return userSpecifiedName ?? snakeCase(targetName);
  }

  override columnName(propertyName: string, customName: string, embeddedPrefixes: string[]) {
    const prefix = embeddedPrefixes.map((p) => `${snakeCase(p)}_`).join('');
    return prefix + (customName ? customName : snakeCase(propertyName));
  }

  override relationName(propertyName: string): string {
    return snakeCase(propertyName);
  }

  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return snakeCase(`${relationName}_${referencedColumnName}`);
  }

  override joinTableName(
    firstTableName: string,
    secondTableName: string,
    firstPropertyName: string,
  ): string {
    return snakeCase(
      `${firstTableName}_${firstPropertyName.replace(/\./g, '_')}_${secondTableName}`,
    );
  }

  override joinTableColumnName(tableName: string, propertyName: string, columnName?: string) {
    return snakeCase(`${tableName}_${columnName ?? propertyName}`);
  }
}
