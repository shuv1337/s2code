import Svg, { G, Path, Rect } from "react-native-svg";

const BRAND_RED = "#D35C46";
const BRAND_SCREEN = "#0C1119";
const BRAND_PROMPT = "#E7ECF3";

/** The canonical shuv2code devil-terminal mark used by the desktop sidebar. */
export function Shuv2CodeMark(props: { readonly height: number }) {
  return (
    <Svg
      accessibilityLabel="shuv2code"
      height={props.height}
      width={props.height}
      viewBox="0 0 512 512"
    >
      <G transform="translate(-57 -14) scale(1.058)">
        <Path d="M396 406c54-4 74-28 74-70" fill="none" stroke={BRAND_RED} strokeWidth={36} />
        <Path d="M504 336H436l34-58z" fill={BRAND_RED} />
        <Path
          d="M104 68c24 40 46 56 86 58 44 4 88 4 132 0 40-2 62-18 86-58 12 40 16 72 16 122v182a72 72 0 0 1-72 72H160a72 72 0 0 1-72-72V190c0-50 4-82 16-122Z"
          fill={BRAND_RED}
        />
        <Rect width={272} height={256} x={120} y={158} fill={BRAND_SCREEN} rx={46} />
        <Path
          d="m180 232 62 60-62 60m88-6h72"
          fill="none"
          stroke={BRAND_PROMPT}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={30}
        />
      </G>
    </Svg>
  );
}
