import { Container } from 'typedi';
import { getMetadataArgsStorage } from 'typeorm';

import { ColumnMetadata, getMetadataStorage, ModelMetadata } from '../metadata';

import {
  columnToGraphQLType,
  columnTypeToGraphQLDataType,
  columnInfoToTypeScriptType
} from './type-conversion';

const ignoreBaseModels = ['BaseModel', 'BaseModelUUID'];

export function getColumnsForModel(model: ModelMetadata) {
  const models = [model];
  const columns: { [key: string]: ColumnMetadata } = {};

  let superProto = model.klass ? model.klass.__proto__ : null;
  while (superProto) {
    const superModel = getMetadataStorage().getModel(superProto.name);
    superModel && models.unshift(superModel);
    superProto = superProto.__proto__;
  }

  models.forEach(aModel => {
    aModel.columns.forEach((col: ColumnMetadata) => {
      columns[col.propertyName] = col;
    });
  });

  return Object.values(columns);
}

export function filenameToImportPath(filename: string): string {
  return filename.replace(/\.(j|t)s$/, '').replace(/\\/g, '/');
}

export function columnToGraphQLDataType(column: ColumnMetadata): string {
  return columnTypeToGraphQLDataType(column.type, column.enumName);
}

export function columnToTypeScriptType(column: ColumnMetadata): string {
  return columnInfoToTypeScriptType(column.type, column.enumName);
}

export function generateEnumMapImports(): string[] {
  const imports: string[] = [];
  const enumMap = getMetadataStorage().enumMap;

  Object.keys(enumMap).forEach((tableName: string) => {
    Object.keys(enumMap[tableName]).forEach((columnName: string) => {
      const enumColumn = enumMap[tableName][columnName];
      const filename = filenameToImportPath(enumColumn.filename);
      imports.push(`import { ${enumColumn.name} } from '${filename}'
`);
    });
  });

  const classMap = getMetadataStorage().classMap;
  Object.keys(classMap).forEach((tableName: string) => {
    const classObj = classMap[tableName];
    const filename = filenameToImportPath(classObj.filename);
    // Need to ts-ignore here for when we export compiled code
    // otherwise, it says we can't find a declaration file for this from the compiled code
    imports.push('// @ts-ignore\n');
    imports.push(`import { ${classObj.name} } from '${filename}'
`);
  });

  return imports;
}

export function entityToWhereUniqueInput(model: ModelMetadata): string {
  const uniques = getMetadataStorage().uniquesForModel(model);
  const others = getMetadataArgsStorage().uniques;
  const modelUniques: { [key: string]: string } = {};
  others.forEach(o => {
    const name = (o.target as Function).name;
    const columns = o.columns as string[];
    if (name === model.name && columns) {
      columns.forEach((col: string) => {
        modelUniques[col] = col;
      });
    }
  });
  uniques.forEach(unique => {
    modelUniques[unique] = unique;
  });
  const distinctUniques = Object.keys(modelUniques);

  // If there is only one unique field, it should not be nullable
  const uniqueFieldsAreNullable = distinctUniques.length > 1;

  let fieldsTemplate = '';

  const modelColumns = getColumnsForModel(model);
  modelColumns.forEach((column: ColumnMetadata) => {
    // Uniques can be from Field or Unique annotations
    if (!modelUniques[column.propertyName]) {
      return;
    }

    const nullable = uniqueFieldsAreNullable ? ', { nullable: true }' : '';
    let graphQLDataType = columnToGraphQLDataType(column);
    let tsType = columnToTypeScriptType(column);

    // Note: HACK for backwards compatability
    // Will fix this in 2.0
    if (column.propertyName === 'id') {
      tsType = 'string';
      graphQLDataType = 'String';
    }

    fieldsTemplate += `
        @TypeGraphQLField(() => ${graphQLDataType}${nullable})
        ${column.propertyName}?: ${tsType};
      `;
  });

  const superName = model.klass ? model.klass.__proto__.name : null;

  const classDeclaration =
    superName && !ignoreBaseModels.includes(superName)
      ? `${model.name}WhereUniqueInput extends ${superName}WhereUniqueInput`
      : `${model.name}WhereUniqueInput`;

  const template = `
    @TypeGraphQLInputType()
    export class ${classDeclaration} {
      ${fieldsTemplate}
    }
  `;

  return template;
}

export function entityToCreateInput(model: ModelMetadata): string {
  const idsOnCreate =
    (Container.get('Config') as any).get('ALLOW_OPTIONAL_ID_ON_CREATE') === 'true';

  let fieldTemplates = '';

  if (idsOnCreate) {
    fieldTemplates += `
      @TypeGraphQLField({ nullable: true })
      id?: string;
    `;
  }

  const modelColumns = getColumnsForModel(model);
  modelColumns.forEach((column: ColumnMetadata) => {
    if (!column.editable) {
      return;
    }
    const graphQLDataType = columnToGraphQLDataType(column);
    const nullable = column.nullable ? '{ nullable: true }' : '';
    const tsRequired = column.nullable ? '?' : '!';
    const tsType = columnToTypeScriptType(column);

    if (columnRequiresExplicitGQLType(column)) {
      fieldTemplates += `
          @TypeGraphQLField(() => ${graphQLDataType}, ${nullable})
          ${column.propertyName}${tsRequired}: ${tsType};
       `;
    } else if (column.type === 'id') {
      // HACK: the following block is to keep things backwards compatable
      // the codegen previously incorrectly set some IDs to Strings
      // NOTE: this will be fixed in v2.0
      fieldTemplates += `
          @TypeGraphQLField(() => String, ${nullable})
          ${column.propertyName}${tsRequired}: ${tsType};
       `;
    } else {
      fieldTemplates += `
          @TypeGraphQLField(${nullable})
          ${column.propertyName}${tsRequired}: ${tsType};
        `;
    }
  });

  const superName = model.klass ? model.klass.__proto__.name : null;

  const classDeclaration =
    superName && !ignoreBaseModels.includes(superName)
      ? `${model.name}CreateInput extends ${superName}CreateInput`
      : `${model.name}CreateInput`;

  return `
    @TypeGraphQLInputType()
    export class ${classDeclaration} {
      ${fieldTemplates}
    }
  `;
}

export function entityToUpdateInput(model: ModelMetadata): string {
  let fieldTemplates = '';

  const modelColumns = getColumnsForModel(model);
  modelColumns.forEach((column: ColumnMetadata) => {
    if (!column.editable) {
      return;
    }

    // TODO: also don't allow updated foreign key fields
    // Example: photo.userId: String
    const graphQLDataType = columnToGraphQLDataType(column);
    const tsType = columnToTypeScriptType(column);

    if (columnRequiresExplicitGQLType(column)) {
      fieldTemplates += `
        @TypeGraphQLField(() => ${graphQLDataType}, { nullable: true })
        ${column.propertyName}?: ${tsType};
      `;
    } else if (column.type === 'id') {
      // HACK: the following block is to keep things backwards compatable
      // the codegen previously incorrectly set some IDs to Strings
      // NOTE: this will be fixed in v2.0
      fieldTemplates += `
        @TypeGraphQLField(() => String, { nullable: true })
        ${column.propertyName}?: ${tsType};
     `;
    } else {
      fieldTemplates += `
        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}?: ${tsType};
      `;
    }
  });

  const superName = model.klass ? model.klass.__proto__.name : null;

  const classDeclaration =
    superName && !ignoreBaseModels.includes(superName)
      ? `${model.name}UpdateInput extends ${superName}UpdateInput`
      : `${model.name}UpdateInput`;

  return `
    @TypeGraphQLInputType()
    export class ${classDeclaration} {
      ${fieldTemplates}
    }
  `;
}

// Constructs required arguments needed when doing an update
export function entityToUpdateInputArgs(model: ModelMetadata): string {
  return `
    @ArgsType()
    export class ${model.name}UpdateArgs {
      @TypeGraphQLField() data!: ${model.name}UpdateInput;
      @TypeGraphQLField() where!: ${model.name}WhereUniqueInput;
    }
  `;
}

function columnToTypes(column: ColumnMetadata) {
  const graphqlType = columnToGraphQLType(column.type, column.enumName);
  const tsType = columnToTypeScriptType(column);

  return { graphqlType, tsType };
}

export function entityToWhereInput(model: ModelMetadata): string {
  let fieldTemplates = '';

  const modelColumns = getColumnsForModel(model);
  modelColumns.forEach((column: ColumnMetadata) => {
    // Don't allow filtering on these fields
    if (!column.filter) {
      return;
    }

    const { tsType } = columnToTypes(column);

    const graphQLDataType = columnToGraphQLDataType(column);

    // TODO: for foreign key fields, only allow the same filters as ID below
    // Example: photo.userId: String
    if (column.type === 'id') {
      // HACK: the following block is to keep things backwards compatable
      // the codegen previously incorrectly set some IDs to Strings
      // NOTE: this will be fixed in v2.0
      let graphQlType = 'ID';
      if (
        column.propertyName === 'id' ||
        column.propertyName === 'createdById' ||
        column.propertyName === 'updatedById' ||
        column.propertyName === 'deletedById'
      ) {
        graphQlType = 'String';
      }

      // Note: TypeScript types will be updated to ID in v2.0
      fieldTemplates += `
        @TypeGraphQLField(() => ${graphQlType},{ nullable: true })
        ${column.propertyName}_eq?: string;
      `;

      // HACK: this needs to remain missing for backwards-compatability
      // This will be fixed in 2.0
      if (
        column.propertyName !== 'createdById' &&
        column.propertyName !== 'updatedById' &&
        column.propertyName !== 'deletedById'
      ) {
        fieldTemplates += `
        @TypeGraphQLField(() => [${graphQlType}], { nullable: true })
        ${column.propertyName}_in?: string[];
        `;
      }
    } else if (column.type === 'boolean') {
      fieldTemplates += `
        @TypeGraphQLField(() => ${graphQLDataType},{ nullable: true })
        ${column.propertyName}_eq?: Boolean;

        @TypeGraphQLField(() => [${graphQLDataType}], { nullable: true })
        ${column.propertyName}_in?: Boolean[];
      `;
    } else if (column.type === 'string' || column.type === 'email') {
      // TODO: do we need NOT?
      // `${column.propertyName}_not`
      fieldTemplates += `
        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_eq?: ${tsType};

        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_contains?: ${tsType};

        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_startsWith?: ${tsType};

        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_endsWith?: ${tsType};

        @TypeGraphQLField(() => [${graphQLDataType}], { nullable: true })
        ${column.propertyName}_in?: ${tsType}[];
      `;
    } else if (column.type === 'float' || column.type === 'integer' || column.type === 'numeric') {
      fieldTemplates += `
        @TypeGraphQLField(() => ${graphQLDataType}, { nullable: true })
        ${column.propertyName}_eq?: ${tsType};

        @TypeGraphQLField(() => ${graphQLDataType}, { nullable: true })
        ${column.propertyName}_gt?: ${tsType};

        @TypeGraphQLField(() => ${graphQLDataType}, { nullable: true })
        ${column.propertyName}_gte?: ${tsType};

        @TypeGraphQLField(() => ${graphQLDataType}, { nullable: true })
        ${column.propertyName}_lt?: ${tsType};

        @TypeGraphQLField(() => ${graphQLDataType}, { nullable: true })
        ${column.propertyName}_lte?: ${tsType};

        @TypeGraphQLField(() => [${graphQLDataType}], { nullable: true })
        ${column.propertyName}_in?: ${tsType}[];
      `;
    } else if (column.type === 'date') {
      // I really don't like putting this magic here, but it has to go somewhere
      // This deletedAt_all turns off the default filtering of soft-deleted items
      if (column.propertyName === 'deletedAt') {
        fieldTemplates += `
          @TypeGraphQLField({ nullable: true })
          deletedAt_all?: Boolean;
        `;
      }

      let tsType = 'Date';
      if (
        column.propertyName === 'createdAt' ||
        column.propertyName === 'updatedAt' ||
        column.propertyName === 'deletedAt'
      ) {
        tsType = 'String';
      }

      // Note: All of the TypeScript types will be DateTime in v2.0
      fieldTemplates += `
        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_eq?: ${tsType};

        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_lt?: ${tsType};

        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_lte?: ${tsType};

        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_gt?: ${tsType};

        @TypeGraphQLField({ nullable: true })
        ${column.propertyName}_gte?: ${tsType};
      `;
    } else if (column.type === 'enum') {
      // Enums will fall through here
      fieldTemplates += `
        @TypeGraphQLField(() => ${graphQLDataType}, { nullable: true })
        ${column.propertyName}_eq?: ${graphQLDataType};

        @TypeGraphQLField(() => [${graphQLDataType}], { nullable: true })
        ${column.propertyName}_in?: ${graphQLDataType}[];
      `;
    } else if (column.type === 'json') {
      // Determine how to handle JSON
    }
  });

  const superName = model.klass ? model.klass.__proto__.name : null;

  const classDeclaration =
    superName && !ignoreBaseModels.includes(superName)
      ? `${model.name}WhereInput extends ${superName}WhereInput`
      : `${model.name}WhereInput`;

  return `
    @TypeGraphQLInputType()
    export class ${classDeclaration} {
      ${fieldTemplates}
    }
  `;
}

export function entityToWhereArgs(model: ModelMetadata): string {
  return `
    @ArgsType()
    export class ${model.name}WhereArgs extends PaginationArgs {
      @TypeGraphQLField(() => ${model.name}WhereInput, { nullable: true })
      where?: ${model.name}WhereInput;

      @TypeGraphQLField(() => ${model.name}OrderByEnum, { nullable: true })
      orderBy?: ${model.name}OrderByEnum;
    }
  `;
}

// Note: it would be great to inject a single `Arg` with the [model.nameCreateInput] array arg,
// but that is not allowed by TypeGraphQL
export function entityToCreateManyArgs(model: ModelMetadata): string {
  return `
    @ArgsType()
    export class ${model.name}CreateManyArgs {
      @TypeGraphQLField(() => [${model.name}CreateInput])
      data!: ${model.name}CreateInput[];
    }
  `;
}

export function entityToOrderByEnum(model: ModelMetadata): string {
  let fieldsTemplate = '';

  const modelColumns = getColumnsForModel(model);
  modelColumns.forEach((column: ColumnMetadata) => {
    if (column.type === 'json') {
      return;
    }

    if (column.sort) {
      fieldsTemplate += `
        ${column.propertyName}_ASC = '${column.propertyName}_ASC',
        ${column.propertyName}_DESC = '${column.propertyName}_DESC',
      `;
    }
  });

  return `
    export enum ${model.name}OrderByEnum {
      ${fieldsTemplate}
    }

    registerEnumType(${model.name}OrderByEnum, {
      name: '${model.name}OrderByInput'
    });
  `;
}

function columnRequiresExplicitGQLType(column: ColumnMetadata) {
  return column.enum || column.type === 'json' || column.type === 'id';
}