import type { ColorValue } from "react-native";
import Svg, { G, Path, Rect } from "react-native-svg";

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const color = props.color ?? "#D35C46";
  return (
    <Svg
      accessibilityLabel="shuv2code"
      height={props.height}
      width={props.height}
      viewBox="0 0 512 512"
    >
      <G transform="translate(256 256) scale(1.08) translate(-256 -256)">
        <G transform="translate(-57 -14) scale(1.058)">
          <Path d="M396 406c54-4 74-28 74-70" fill="none" stroke={color} strokeWidth={36} />
          <Path
            fill={color}
            d="M504 336H436l34-58zM104 68c24 40 46 56 86 58 44 4 88 4 132 0 40-2 62-18 86-58 12 40 16 72 16 122v182a72 72 0 0 1-72 72H160a72 72 0 0 1-72-72V190c0-50 4-82 16-122Z"
          />
          <Rect width={272} height={256} x={120} y={158} fill="#0C1119" rx={46} />
          <Path
            fill="none"
            stroke="#E7ECF3"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={30}
            d="m180 232 62 60-62 60m88 -6h72"
          />
        </G>
      </G>
    </Svg>
  );
}
