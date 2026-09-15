/* ══════════════════════════════════════════════════════════════
   关键字表

   按语言族共享（C 和 Java 的差异没大到值得各写一份）。
   多染一个词不影响阅读，漏染才影响 —— 所以宁可写宽一点。

   用模板串写再 split，比 ['a','b','c'] 好维护：加词就是敲空格。
   ══════════════════════════════════════════════════════════════ */

const words = (text: string): string[] => text.trim().split(/\s+/)

export const JS = words(`
  abstract as async await break case catch class const continue debugger declare default delete
  do else enum export extends finally for from function get if implements import in instanceof
  interface let new of private protected public readonly return satisfies set static super
  switch this throw try type typeof undefined var void while with yield
`)

export const PY = words(`
  and as assert async await break class continue def del elif else except finally for from
  global if import in is lambda match nonlocal not or pass raise return try while with yield
`)

export const RS = words(`
  as async await break const continue crate dyn else enum extern fn for if impl in let loop
  match mod move mut pub ref return self static struct super trait type unsafe use where while
  box
`)

export const GO = words(`
  break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var
`)

export const C = words(`
  auto break case const continue default do else enum extern for goto if inline register
  restrict return sizeof static struct switch typedef union volatile while
`)

export const CPP = words(`
  alignas alignof auto break case catch class concept const consteval constexpr continue
  co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export
  extern for friend goto if inline mutable namespace new noexcept operator private protected
  public register reinterpret_cast requires return sizeof static static_assert static_cast
  struct switch template this thread_local throw try typedef typeid typename union using
  virtual volatile while
`)

export const JAVA = words(`
  abstract assert break case catch class const continue default do else enum extends final
  finally for goto if implements import instanceof interface native new package private
  protected public record return sealed static strictfp super switch synchronized this throw
  throws transient try var volatile while yield
`)

export const CS = words(`
  abstract as async await base break case catch checked class const continue default delegate
  do else enum event explicit extern finally fixed for foreach get goto if implicit in
  interface internal is lock namespace new operator out override params private protected
  public readonly record ref return sealed set sizeof stackalloc static struct switch this
  throw try typeof unchecked unsafe using var virtual void volatile when where while yield
`)

export const PHP = words(`
  abstract and array as break callable case catch class clone const continue declare default do
  echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final
  finally fn for foreach function global goto if implements include include_once instanceof
  insteadof interface isset list match namespace new or print private protected public readonly
  require require_once return static switch throw trait try unset use var while xor yield
`)

export const RB = words(`
  alias and begin break case class def defined do else elsif end ensure for if in module next
  nil not or redo rescue retry return self super then undef unless until when while yield
  attr_accessor attr_reader attr_writer require require_relative puts lambda proc
`)

export const SWIFT = words(`
  actor as associatedtype async await break case catch class continue convenience default defer
  deinit do else enum extension fallthrough fileprivate for func guard if import in indirect
  init inout internal is lazy let mutating nil nonisolated open operator optional override
  private protocol public repeat required rethrows return self static struct subscript super
  switch throw throws try typealias var where while
`)

export const KOTLIN = words(`
  abstract actual annotation as break by catch class companion const constructor continue
  crossinline data delegate do dynamic else enum expect external final finally for fun get if
  import in infix init inline inner interface internal is lateinit noinline object open operator
  out override package private protected public reified return sealed set suspend tailrec this
  throw try typealias val var vararg when where while
`)

export const SH = words(`
  alias bg break case cd continue declare do done echo elif else esac eval exec exit export fi
  for function getopts if in local printf read readonly return select set shift source then time
  trap type ulimit umask unalias unset until wait while
`)

export const PS = words(`
  begin break catch class continue data do dynamicparam else elseif end enum exit filter finally
  for foreach from function if in param process return switch throw trap try until using while
  workflow
`)

export const SQL = words(`
  add all alter and any as asc begin between by case cast check column commit constraint create
  cross delete desc distinct drop else end exists foreign from full grant group having if in
  index inner insert into is join key left like limit not null offset on or order outer primary
  references replace right rollback select set table then top transaction trigger union unique
  update values view when where with
`)

export const LUA = words(`
  and break do else elseif end false for function goto if in local nil not or repeat return then
  true until while
`)

export const R = words(
  `break else for function if in next repeat return switch while library require`,
)

export const DOCKER = words(`
  add arg cmd copy entrypoint env expose from healthcheck label maintainer onbuild run shell
  stopsignal user volume workdir as
`)

export const MAKE = words(
  `define endef else endif if ifdef ifndef include override export unexport vpath`,
)

/* ── 内建类型 / 常见类名 ─────────────────────────────────────── */

export const JS_TYPES = words(`
  string number boolean object symbol bigint any unknown never void Array Object Promise Map Set
  Date RegExp Error JSON Math String Number Boolean Symbol BigInt Record Partial Readonly Pick
  Omit Exclude Extract NonNullable Awaited
`)

export const SYS_TYPES = words(`
  int char short long float double void bool size_t ssize_t ptrdiff_t uint8_t uint16_t uint32_t
  uint64_t int8_t int16_t int32_t int64_t FILE va_list
`)

export const KS_TYPES = words(`
  int float double boolean char byte short long void string String Integer Double Float Boolean
  Long Short Byte Char Object List Map Set Optional Any
`)

export const RS_TYPES = words(`
  i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str Vec Option Result
  Box Rc Arc HashMap HashSet BTreeMap
`)

export const GO_TYPES = words(`
  bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string
  uint uint8 uint16 uint32 uint64 uintptr any
`)

export const PY_TYPES = words(`
  int float complex bool str bytes list tuple set dict frozenset object type range slice
  bytearray memoryview Exception ValueError TypeError KeyError IndexError RuntimeError
  AttributeError
`)

/** 字面量常量 —— 各语言都认，混着写不影响 */
export const CONSTANTS = words(`
  true false null nil none undefined NaN Infinity NULL TRUE FALSE None True False self this
  super yes no on off
`)
