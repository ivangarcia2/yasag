import * as _ from "lodash";
import * as nodePath from "path";

import { normalizeDef } from "../common";
import { nativeTypes } from "../conf";
import { ProcessedDefinition } from "../definitions";
import { Config } from "../generate";
import { parameterToSchema } from "../requests/process-params";
import { MethodOutput } from "../requests/requests.models";
import { NativeNames, Parameter, Schema } from "../types";
import { indent, out, TermColors, writeFile } from "../utils";

export interface FieldDefinition {
  content: string;
  params: string[];
}

export function generateFormService(
  config: Config,
  name: string,
  params: Parameter[],
  definitions: ProcessedDefinition[],
  simpleName: string,
  formSubDirName: string,
  className: string,
  methodName: string,
  method: MethodOutput,
  readOnly: string
) {
  let content = "";
  const formName = "form";
  const formArrayReset: string[] = [];
  const formArrayPatch: string[] = [];
  const componentHTMLFileName = nodePath.join(
    formSubDirName,
    `${simpleName}.service.ts`
  );

  out(`Generating ${componentHTMLFileName}`, TermColors.default);

  const constructor = getConstructor(
    name,
    formName,
    className,
    definitions,
    params,
    formArrayReset,
    formArrayPatch,
    readOnly
  );

  const variables = getVariables(method);

  // Imports
  content += getImports(name, constructor, methodName);

  // Class declaration
  content += `@Injectable()\n`;
  if (methodName === "get") {
    content += `export class ${className}FormService extends YASAGGetFormService<${method.responseDef.type}> {\n`;
  } else {
    content += `export class ${className}FormService extends YASAGPostFormService<${method.responseDef.type}> {\n`;
  }

  // Class variables

  content += variables;

  // Constructor and add & remove form methods
  content += constructor;

  // Submit function
  content += getFormSubmitFunction(simpleName, params, methodName, method);
  content += `\n\n`;

  // Reset function
  content += getFormResetFunction(
    formName,
    formArrayReset,
    formArrayPatch,
    methodName
  );

  content += "}\n";

  writeFile(componentHTMLFileName, content, config.header);
}

function getImports(name: string, constructor: string, methodName: string) {
  const imports: string[] = [];

  if (constructor.match(/new FormArray\(/)) imports.push("FormArray");
  if (constructor.match(/new FormControl\(/)) imports.push("FormControl");
  if (constructor.match(/new FormGroup\(/)) imports.push("FormGroup");
  if (constructor.match(/\[Validators\./)) imports.push("Validators");

  let res = "import { Injectable, NgZone } from '@angular/core';\n";
  if (imports.length)
    res += `import {${imports.join(", ")}} from '@angular/forms';\n`;
  res += "import {  Observable } from 'rxjs';\n";
  res += `import { ${name}Service } from '../../../controllers/${name}';\n`;
  res += `import * as __model from '../../../model';\n`;
  res += "import { APIConfigService } from '../../../apiconfig.service';\n\n";
  res += "import * as __utils from '../../../yasag-utils';\n\n";

  if (methodName === "get") {
    res += "import { YASAGGetFormService } from '../../yasag-get.service';\n\n";
  } else {
    res +=
      "import { YASAGPostFormService } from '../../yasag-post.service';\n\n";
  }

  res += "\n";

  return res;
}

function getVariables(method: MethodOutput): string {
  let content = "";
  Object.keys(method.method.method).forEach((k) => {
    if (k.startsWith("x-")) {
      content += indent(
        `static ${_.camelCase(k)} = ${JSON.stringify(
          method.method.method[k]
        )};\n`
      );
    }
  });

  return content;
}

function getConstructor(
  name: string,
  formName: string,
  className: string,
  definitions: ProcessedDefinition[],
  params: Parameter[],
  formArrayReset: string[],
  formArrayPatch: string[],
  readOnly: string
) {
  const definitionsMap = _.groupBy(definitions, "name");
  const parentTypes: string[] = [];
  const formArrayMethods: string[] = [];
  const formDefinition = walkParamOrProp(
    params,
    undefined,
    definitionsMap,
    parentTypes,
    `this.${formName}`,
    formArrayMethods,
    "value",
    "value",
    formArrayReset,
    formArrayPatch,
    readOnly
  );

  let res = indent("constructor(\n");
  res += indent(`apiConfigService: APIConfigService,\n`, 2);
  res += indent(`ngZone: NgZone,\n`, 2);
  res += indent(`private service: ${name}Service,\n`, 2);
  res += indent(") {\n");

  res += indent(`super('${className}', apiConfigService, ngZone);\n`, 2);
  res += indent(
    `this.${formName} = new FormGroup({\n${formDefinition}\n});\n`,
    2
  );
  res += indent(`this.init()\n`, 2);
  res += indent("}\n");
  res += "\n";

  for (const method in formArrayMethods) {
    res += formArrayMethods[method];
    res += "\n";
  }

  return res;
}

function walkParamOrProp(
  definition: Parameter[] | ProcessedDefinition,
  path: string[] = [],
  definitions: _.Dictionary<ProcessedDefinition[]>,
  parentTypes: string[],
  control: string,
  formArrayMethods: string[],
  formValue: string,
  formValueIF: string,
  formArrayReset: string[],
  formArrayPatch: string[],
  readOnly: string,
  formArrayParams = "",
  subArrayReset: string[] = [],
  subArrayPatch: string[] = [],
  parent = "",
  parents = "",
  nameParents = ""
): string {
  const res: string[] = [];
  let schema: Record<string, Schema>;
  let required: string[];

  // create unified inputs for
  // 1. parameters
  if (Array.isArray(definition)) {
    schema = {};
    required = [];
    definition.forEach((param) => {
      if (param.required) required.push(param.name);
      schema[param.name] = parameterToSchema(param);
    });
    // 2. object definition
  } else {
    required = definition.def.required;
    schema = definition.def.properties || {};
  }

  // walk the list and build recursive form model
  Object.entries(schema).forEach(([paramName, param]) => {
    const ref = param.$ref;

    // break type definition chain with cycle
    if (parentTypes.indexOf(ref) >= 0) return;

    const name = paramName;
    const newPath = [...path, name];
    const isRequired = required && required.includes(name);

    let newParentTypes: string[] = [];
    if (ref) newParentTypes = [...parentTypes, ref];

    if (readOnly && name.endsWith(readOnly)) {
      param.readOnly = true;
    }

    if (!param.readOnly || name === "id") {
      const fieldDefinition = makeField(
        param,
        ref,
        name,
        newPath,
        isRequired,
        definitions,
        newParentTypes,
        `${control}['controls']['${name}']`,
        formArrayMethods,
        formValue + `['${name}']`,
        `${formValueIF} && ${formValue}['${name}']`,
        formArrayReset,
        formArrayPatch,
        formArrayParams,
        subArrayReset,
        subArrayPatch,
        parent,
        parents,
        nameParents,
        readOnly
      );

      res.push(fieldDefinition);
    }
  });

  return indent(res);
}

function makeField(
  param: Schema,
  ref: string,
  name: string,
  path: string[],
  required: boolean,
  definitions: _.Dictionary<ProcessedDefinition[]>,
  parentTypes: string[],
  formControl: string,
  formArrayMethods: string[],
  formValue: string,
  formValueIF: string,
  formArrayReset: string[],
  formArrayPatch: string[],
  formArrayParams: string,
  subArrayReset: string[],
  subArrayPatch: string[],
  parent: string,
  parents: string,
  nameParents = "",
  readOnly: string
): string {
  let definition: ProcessedDefinition;
  let type = param.type;
  let control: string;
  let initializer: string;

  if (type) {
    if (type in nativeTypes) {
      const typedType = type as NativeNames;
      type = nativeTypes[typedType];
    }

    // use helper method and store type definition to add new array items
    if (type === "array") {
      if (param.items.type) {
        control = "FormControl";
        initializer = "[]";
      } else {
        const refType = param.items.$ref.replace(/^#\/definitions\//, "");
        definition = definitions[normalizeDef(refType)][0];
        const mySubArrayReset: string[] = [];
        const mySubArrayPatch: string[] = [];
        const fields = walkParamOrProp(
          definition,
          path,
          definitions,
          parentTypes,
          formControl + `['controls'][${name}]`,
          formArrayMethods,
          formValue + `[${name}]`,
          formValueIF,
          formArrayReset,
          formArrayPatch,
          readOnly,
          formArrayParams + name + ": number" + ", ",
          mySubArrayReset,
          mySubArrayPatch,
          name,
          parents + name + ", ",
          nameParents + _.upperFirst(_.camelCase(name.replace("_", "-")))
        );
        control = "FormArray";
        initializer = `[]`;
        let addMethod = "";
        addMethod += indent(
          `public add${nameParents}${_.upperFirst(
            _.camelCase(name.replace("_", "-"))
          )}(${formArrayParams} ${name}: number = 1, position?: number, value?: any): void {\n`
        );
        addMethod += indent(`const control = <FormArray>${formControl};\n`, 2);
        addMethod += indent(
          `const fg = new FormGroup({\n${fields}\n}, []);\n`,
          2
        );
        addMethod += indent(
          `__utils.addField(control,${name}, fg, position, value);\n`,
          2
        );

        addMethod += indent(`}\n`);
        formArrayMethods.push(addMethod);

        let removeMethod = "";
        removeMethod += indent(
          `public remove${nameParents}${_.upperFirst(
            _.camelCase(name.replace("_", "-"))
          )}(${formArrayParams} i: number): void {\n`
        );
        removeMethod += indent(
          `const control = <FormArray>${formControl};\n`,
          2
        );
        removeMethod += indent(`control.removeAt(i);\n`, 2);
        removeMethod += indent(`}\n`);
        formArrayMethods.push(removeMethod);

        if (formArrayParams === "") {
          let resetMethod = "";
          resetMethod += indent(
            `while ((<FormArray>${formControl}).length) {\n`
          );
          resetMethod += indent(
            `this.remove${nameParents}${_.upperFirst(
              _.camelCase(name.replace("_", "-"))
            )}(0);\n`,
            2
          );
          resetMethod += indent(`}\n`);
          resetMethod += indent(`if (${formValueIF}) {\n`);
          resetMethod += indent(
            `this.add${nameParents}${_.upperFirst(
              _.camelCase(name.replace("_", "-"))
            )}(${formValue}.length);\n`,
            2
          );
          mySubArrayReset.forEach((subarray) => {
            resetMethod += indent(`${formValue}.forEach(${subarray});\n`, 2);
          });
          resetMethod += indent(`}\n`);
          formArrayReset.push(resetMethod);

          let patchMethod = "";
          patchMethod += indent(`if (${formValueIF}) {\n`);
          patchMethod += indent(
            `while (${formValue}.length < this.form.${formValue}.length) {\n`,
            2
          );
          patchMethod += indent(
            `this.remove${nameParents}${_.upperFirst(
              _.camelCase(name.replace("_", "-"))
            )}(0);\n`,
            3
          );
          patchMethod += indent(`}\n`, 2);
          patchMethod += indent(
            `if (${formValue}.length > this.form.${formValue}.length) {\n`,
            2
          );
          patchMethod += indent(
            `this.add${nameParents}${_.upperFirst(
              _.camelCase(name.replace("_", "-"))
            )}(${formValue}.length - this.form.${formValue}.length);\n`,
            3
          );
          patchMethod += indent(`}\n`, 2);
          mySubArrayPatch.forEach((subarray) => {
            patchMethod += indent(`${formValue}.forEach(${subarray});\n`, 2);
          });
          patchMethod += indent(`}\n`);
          formArrayPatch.push(patchMethod);
        } else {
          let resetMethod = "";
          resetMethod += `(${parent}_object, ${parent}) => {\n`;
          resetMethod += indent(`if (${formValueIF}) {\n`);
          resetMethod += indent(
            `this.add${nameParents}${_.upperFirst(
              _.camelCase(name.replace("_", "-"))
            )}(${parents}${formValue}.length);\n`,
            2
          );
          mySubArrayReset.forEach((subarray) => {
            resetMethod += indent(`${formValue}.forEach(${subarray});\n`, 2);
          });
          resetMethod += indent(`}\n`);
          resetMethod += `}`;
          subArrayReset.push(resetMethod);

          let patchMethod = "";
          patchMethod += `(${parent}_object, ${parent}) => {\n`;
          patchMethod += indent(`if (${formValueIF}) {\n`);
          patchMethod += indent(
            `if (${formValue}.length > this.form.${formValue}.length) {\n`,
            2
          );
          patchMethod += indent(
            `this.add${nameParents}${_.upperFirst(
              _.camelCase(name.replace("_", "-"))
            )}(${parents}${formValue}.length - this.form.${formValue}.length);\n`,
            3
          );
          patchMethod += indent(`}\n`, 2);
          mySubArrayPatch.forEach((subarray) => {
            patchMethod += indent(`${formValue}.forEach(${subarray});\n`, 2);
          });
          patchMethod += indent(`}\n`);
          patchMethod += `}`;
          subArrayPatch.push(patchMethod);
        }
      }
    } else {
      control = "FormControl";
      initializer =
        typeof param.default === "string"
          ? `'${param.default}'`
          : param.default;
      initializer = `{value: ${initializer}, disabled: false}`;
    }
  } else {
    const refType = ref.replace(/^#\/definitions\//, "");
    definition = definitions[normalizeDef(refType)][0];

    control = "FormGroup";
    const fields = walkParamOrProp(
      definition,
      path,
      definitions,
      parentTypes,
      formControl,
      formArrayMethods,
      formValue,
      formValueIF,
      formArrayReset,
      formArrayPatch,
      readOnly,
      formArrayParams,
      subArrayReset,
      subArrayPatch,
      parent,
      parents,
      nameParents + _.upperFirst(_.camelCase(name.replace("_", "-")))
    );
    initializer = `{\n${fields}\n}`;
  }

  const validators = getValidators(param);
  if (required) validators.push("Validators.required");

  return `${name}: new ${control}(${initializer}, [${validators.join(", ")}]),`;
}

function getValidators(param: Parameter | Schema) {
  const validators: string[] = [];

  if (param.format && param.format === "email")
    validators.push("Validators.email");

  if (param.maximum) validators.push(`Validators.max(${param.maximum})`);
  if (param.minimum) validators.push(`Validators.min(${param.minimum})`);

  if (param.maxLength)
    validators.push(`Validators.maxLength(${param.maxLength})`);
  if (param.minLength)
    validators.push(`Validators.minLength(${param.minLength})`);

  if (param.pattern) validators.push(`Validators.pattern(/${param.pattern}/)`);

  return validators;
}

function getFormSubmitFunction(
  simpleName: string,
  paramGroups: Parameter[],
  methodName: string,
  method: MethodOutput
) {
  let res = "";
  let type = method.responseDef.type;
  let paramName =
    methodName === "patch" && method.paramGroups.body
      ? method.paramGroups.body[0].name
      : null;
  const isPatch =
    method.methodName === "patch" && method.paramGroups.body !== undefined;

  if (method.responseDef.format && method.responseDef.format === "binary") {
    type = "Blob";
  }

  if (methodName === "get") {
    res += indent(
      `submit(value: any = false, cache = true, only_cache = false): Observable<${type}> {\n`
    );
  } else {
    res += indent(`submit(value: any = false): Observable<${type}> {\n`);
  }

  res += indent(
    `const result = this.service.${simpleName}(${getSubmitFnParameters(
      "value || this.form.value, this.multipart",
      paramGroups
    )});\n`,
    2
  );

  if (methodName === "get") {
    res += indent(
      `return this._submit('${type}', result, value, cache, only_cache );\n`,
      2
    );
  } else {
    res += indent(
      `return this._submit('${type}', result, '${paramName}', value, ${isPatch} );\n`,
      2
    );
  }

  res += indent("}\n");
  res += indent("\n");

  res += indent(
    `listen(value: any = false, submit: boolean = true): Observable<${type}> {\n`
  );

  res += indent("if (submit) {\n", 2);
  res += indent("this.submit(value);\n", 3);
  res += indent("}\n", 2);

  if (methodName === "get") {
    res += indent(`return this._listen('${type}', value, submit);\n`, 2);
  } else {
    res += indent(`return this._listen(value, submit);\n`, 2);
  }

  res += indent("}\n");
  res += indent("\n");

  return res;
}

function getFormResetFunction(
  formName: string,
  formArrayReset: string[],
  formArrayPatch: string[],
  methodName: string
) {
  let res = "";

  if (formArrayReset.length > 0) {
    res += indent("reset(value?: any): void {\n");
    res += indent(`super.reset(value, ${methodName === "patch"}); \n`, 2);
    for (const i in formArrayReset) {
      res += indent(formArrayReset[i]);
    }
    res += indent("}\n\n");
  }

  if (formArrayPatch.length > 0) {
    res += indent("patch(value: any): void {\n");
    for (const i in formArrayPatch) {
      res += indent(formArrayPatch[i]);
    }
    res += indent(`this.${formName}.patchValue(value);\n`, 2);
    res += indent("}\n");
  }

  return res;
}

function getSubmitFnParameters(name: string, paramGroups: Parameter[]) {
  if (paramGroups.length) return name;
  return "";
}
